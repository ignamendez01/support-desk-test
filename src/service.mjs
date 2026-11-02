import { randomUUID } from 'node:crypto';
import { openStore, record, ticketView, DeskError } from './store.mjs';

// This inherited implementation is intentionally incomplete. See README acceptance criteria.
export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
  }
  close() { this.db.close(); }
  listTickets(actor) {
    return this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id').all(actor.tenantId);
  }
  row(actor, id) {
    // Ensure the ticket belongs to the actor's tenant to prevent cross-tenant access
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
    if (!row) throw new DeskError(404, 'Ticket not found');
    return row;
  }
  getTicket(actor, id) { return ticketView(this.db, this.row(actor, id)); }
  receiveWebhook(event) {
    const t = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?')
        .get(event.ticketId, event.tenantId);
    if (!t || !event.eventId || typeof event.body !== 'string') throw new DeskError(400, 'Invalid event');

    // 1. Check if the event was already processed for this ticket to ensure idempotency
    const existing = this.db.prepare('SELECT id FROM messages WHERE ticket_id = ? AND event_id = ?')
        .get(t.id, event.eventId);

    if (existing) {
      // If already processed, acknowledge safely without duplicating the message
      return { accepted: true };
    }

    // 2. Use SQLite native transaction commands for atomic execution
    this.db.exec('BEGIN TRANSACTION;');
    try {
      this.db.prepare('INSERT INTO messages(ticket_id, event_id, body) VALUES (?, ?, ?)')
          .run(t.id, event.eventId, event.body);
      record(this.db, t.id, 'inbound', event.eventId);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }

    return { accepted: true };
  }
  updateDraft(actor, id, body) {
    this.row(actor, id);
    if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');

    // Clear approved_version when a draft is modified, forcing a new approval
    this.db.prepare("UPDATE tickets SET draft = ?, version = version + 1, approved_version = NULL, send_state = 'DRAFT' WHERE id = ?")
        .run(body, id);

    record(this.db, id, 'draft_updated', actor.id);
    return this.getTicket(actor, id);
  }
  approveDraft(actor, id) {
    const t = this.row(actor, id);
    if (!t.draft || !t.draft.trim()) throw new DeskError(400, 'No draft to approve');

    // Set approved_version to match the current version
    this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ?').run(id);
    record(this.db, id, 'approved', actor.id);
    return this.getTicket(actor, id);
  }
  handoff(actor, id) {
    const t = this.row(actor, id);

    // If the ticket is already owned by human, we don't need to re-trigger the handoff log/update
    if (t.owner === 'human') {
      return this.getTicket(actor, id);
    }

    this.db.prepare("UPDATE tickets SET owner = 'human' WHERE id = ?").run(id);
    record(this.db, id, 'human_handoff', actor.id);
    return this.getTicket(actor, id);
  }
  async sendReply(actor, id, { automatic = false } = {}) {
    const t = this.row(actor, id);

    // Guard: Prevent automated actions if a human agent has taken over the ticket
    if (automatic && t.owner === 'human') {
      throw new DeskError(409, 'Automated replies are disabled after human takeover');
    }

    if (t.approved_version == null) throw new DeskError(409, 'Approve the reply first');

    let result;
    const clientRef = randomUUID();

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await this.provider.send({ clientRef, ticketId: id, body: t.draft });
        break;
      } catch (error) {
        // On the second failed attempt, set status to UNKNOWN instead of crashing
        if (attempt === 1) {
          this.db.prepare("UPDATE tickets SET send_state = 'UNKNOWN' WHERE id = ?").run(id);
          record(this.db, id, 'send_unknown', `${automatic ? 'automation' : actor.id}: ${error.message}`);
          return this.getTicket(actor, id);
        }
      }
    }

    // Mark as SENT if successful
    this.db.prepare("UPDATE tickets SET send_state = 'SENT' WHERE id = ?").run(id);
    record(this.db, id, 'sent', `${automatic ? 'automation' : actor.id}: ${result?.providerMessageId || 'ok'}`);
    return this.getTicket(actor, id);
  }
  async reconcile(actor, id) {
    const t = this.row(actor, id);
    if (t.send_state !== 'UNKNOWN') {
      throw new DeskError(400, 'Ticket is not in UNKNOWN state');
    }

    // Query status from provider using the provider instance
    const status = await this.provider.getStatus(id);

    if (status && status.delivered) {
      this.db.prepare("UPDATE tickets SET send_state = 'SENT' WHERE id = ?").run(id);
      record(this.db, id, 'reconciled_sent', actor.id);
    } else if (status && status.failed) {
      this.db.prepare("UPDATE tickets SET send_state = 'FAILED' WHERE id = ?").run(id);
      record(this.db, id, 'reconciled_failed', actor.id);
    }

    return this.getTicket(actor, id);
  }
}
