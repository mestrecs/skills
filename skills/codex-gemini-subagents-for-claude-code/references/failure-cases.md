## Before returning code changes

For every new or changed path, answer with one line per item at the end of your response. Use `ok: <where it is handled>` or `not applicable: <why>`.

1. **Duplicate effects.** If this runs twice because of a retry, a double click, or a repeating job, can it produce the same effect twice?
2. **Interruption.** If the process stops before or after saving data or sending a request or message, what is left? Can work be lost, repeated, or left half finished?
3. **Concurrency.** Can two simultaneous runs interfere with each other, including a scheduled job running alongside a manual request?
4. **Tenant and group isolation.** Can data reach a customer, tenant, or group that does not own it?
5. **Optional behavior.** Put optional features, scheduled jobs, and automated outbound messages behind a flag that defaults to off so they can ship separately.

Run the existing tests for the code you changed, including tests that import or exercise it. Report all failures together.
