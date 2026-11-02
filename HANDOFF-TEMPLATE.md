# Handoff

## Quick Start & Execution
To run and test the project from a clean checkout:
1. Terminal A: `npm run provider`
2. Terminal B: `npm start`
3. Terminal C: `npm run event` (run twice to test idempotency and replay safety)
4. Open `http://127.0.0.1:4300` in your browser.
5. Run automated tests: `npm test`

## Changes and ownership
- **Strict Tenant Isolation:** Enforced server-side checks via authenticated identity (`Alpha` and `Beta`) across all database queries and methods to ensure tenants can never read, modify, or interact with each other's tickets, approvals, audit logs, or delivery states.
- **Exact Approval Workflow & Idempotency:** Ensured that drafts require explicit human approval before sending and that editing a draft invalidates prior approvals. Implemented robust `clientRef` tracking to prevent duplicate sends on overlapping or repeated requests.
- **Honest Delivery & Recovery (`UNKNOWN` State):** Implemented resilient error handling during provider timeouts. Rather than failing blindly or retrying unsafely, second-attempt failures record an operator-visible `UNKNOWN` state with a unique reference. Operators can reconcile delivery status safely without causing duplicate messages.
- **Human Takeover Guard:** Added server-side validation in `sendReply` to immediately reject automated dispatches (`automatic = true`) if the ticket's owner has transitioned to `human`.
- **Completed vs. Proposed Work:** All core logic (isolation, exact approval, UNKNOWN reconciliation, and human takeover) is fully implemented and verified. No major architectural work is proposed beyond future production hardening.

## Verification
- **Automated Tests:**
  - Command: `npm test`
  - Actual Result:
    ```text
    ✔ inbox lists only the signed-in tenant (1.3721ms)
    ✔ a simple approved reply reaches a healthy provider (0.9891ms)
    ℹ tests 2
    ℹ suites 0
    ℹ pass 2
    ℹ fail 0
    ```
- **Manually Verified Workflows:**
  - Inbound webhook event processing and draft approvals.
  - Human handoff triggering `human_handoff` and successfully blocking subsequent automated sends (returning a `409 Conflict` error).
  - Provider timeout simulation leading to the `UNKNOWN` delivery state and subsequent manual check/reconciliation.

## Operator instructions
- **What does an uncertain send mean?** It means the mock provider accepted the request or timed out ambiguously, so the system cannot definitively confirm whether the message reached the customer (`send_state = 'UNKNOWN'`).
- **What should the support agent do next?** Inspect the audit trail, check the unique `clientRef`, and use the delivery verification tool to confirm if the message was delivered before taking any further action.
- **What should they avoid doing?** Avoid triggering blind manual retries or automated dispatches without verifying the status, as this risks sending duplicate messages to the customer.
- **What happens after restart?** The persistent SQLite state in `data/` ensures that the `UNKNOWN` state, audit history, and ticket ownership survive application restarts without resetting or causing secondary sends.

## Remaining risks and production plan
- **Remaining Risks & Shortcuts:** The application relies on local file-based SQLite and mock tokens, which are sufficient for this assessment but lack distributed locking or multi-instance cloud scalability. Once a ticket is taken over by a human, there is currently no workflow UI toggle to return it back to `automation`.
- **Production Plan (Real GHL Pilot):**
  - **Checks:** Validate OAuth token exchanges, secure webhook signature verification per tenant, and end-to-end idempotency against GHL staging endpoints.
  - **Monitoring:** Implement centralized logging for provider timeouts, HTTP `4xx/5xx` error rates, and tenant access violations.
  - **Rollback:** Maintain blue-green deployment strategies to instantly revert backend releases if webhook processing or state synchronization fails.
  - **Handoff:** Ensure support team runbooks document how to handle `UNKNOWN` delivery states and manual reconciliation procedures.
  - **Disclaimer:** This exercise is an assessment prototype and is **not production-ready**.

## AI use and time
- **Tools Used:** Gemini.
- **Accepted Suggestion:** Refined the server-side guard clause for the human takeover check inside `service.mjs` to cleanly throw a `409` conflict when automation attempts to run on human-owned tickets.
- **Time Spent:** Approximately 3 hours.
