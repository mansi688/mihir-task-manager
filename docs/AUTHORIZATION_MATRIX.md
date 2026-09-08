# AUTHORIZATION_MATRIX.md

Every row below is backed by an actual automated test that attacks the boundary directly (not
just a UI element being hidden) — the test file is named so this can be re-verified any time
with `npm test`, not just trusted as a claim.

| Role | Action | Allowed | Backend-verified | Test |
|---|---|---|---|---|
| Member | Close a task they didn't create and aren't the sole approver of | No | Yes | task-lifecycle.test.js |
| Member (follow-up only) | Close/approve/reject a task they're only tagged for follow-up on | No | Yes | permission-security-and-errors.test.js |
| Member | Reopen a task (even one they submitted themselves) | No (Creator/Admin only) | Yes | task-lifecycle.test.js |
| Member | View/act on a subtask's parent task they aren't tagged on | No | Yes | subtask-visibility-regression.test.js |
| Member | Submit a subtask they created but aren't assigned to | No | Yes | subtask-visibility-regression.test.js |
| Member | Access another department's Peak Hours/Performance data | No | Yes | director-role.test.js (via the Director boundary, same underlying check) |
| Director | View their own department's Performance/Peak Hours | Yes | Yes | director-role.test.js |
| Director | View another department's data without being granted it | No | Yes | director-role.test.js |
| Director | Grant themselves additional department visibility | No (Admin only) | Yes | director-role.test.js |
| Director | Access Audit Log | No | Yes | director-role.test.js |
| Director | Access Accounts management | No | Yes | director-role.test.js |
| Director | Do normal task work (create/submit/approve their own tasks) | Yes | Yes | director-role.test.js |
| HR (team member) | View the company-wide employee roster | Yes | Yes | hr-roster.test.js |
| HR | See Admin or Director listed as roster entries | No (excluded for everyone, Admin included) | Yes | hr-roster.test.js |
| Non-HR, non-Admin | View the HR roster | No | Yes | hr-dashboard-visibility.test.js |
| Any authenticated user | View any single task by ID directly | Yes (deliberate, company-wide design — matches the existing "Depends On" cross-team visibility pattern) | Yes (by design, not a gap) | — |
| Any authenticated user | Download another person's task attachment without being involved in that task | No | Yes | database-integrity-and-attachments.test.js |
| Non-admin | Create/remove accounts, reset another user's password, remove a department | No | Yes | accounts-and-teams.test.js |
| Non-admin | View the Audit Log | No | Yes | (admin-only route guard) |
| Any user | Approve an already-approved submission (double-approval) | No (rejected, not silently re-accepted) | Yes | task-lifecycle.test.js |
| Any user | Reject a submission that was never submitted | No | Yes | task-lifecycle.test.js |
| Team Lead | Add a member to a department other than their own | No | Yes | accounts-and-teams.test.js |
| Unauthenticated | Subscribe to push notifications on someone else's behalf | No (401) | Yes | push-and-phone.test.js |
| Unauthenticated | Reset any account's password via the mass-reset script from the API | N/A — that's a CLI-only tool, no API route exists for it | Yes (by design) | — |

## Known gap
This matrix was assembled from the test suite's *existing* coverage, not built as an independent
first-principles enumeration of every possible role×action pair — meaning if a boundary exists
that no test currently attacks, it wouldn't appear here even if it were solid. Recommend treating
this as a living document: any new permission-sensitive endpoint should get both a test *and* a
row here before being considered verified, not just one or the other.
