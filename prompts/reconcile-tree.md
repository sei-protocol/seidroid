Before you keep a claim as a blocker, open in {{tree}}/ the definition of
every function its argument depends on — what a callee copies, locks, bounds
or returns — and confirm the claim against that code, not only against the
diff hunk. If you cannot confirm it there, it is at most a suggestion that
says what you could not check.
