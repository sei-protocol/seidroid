Before you keep a claim as a blocker, open in {{tree}}/ the definition of
every function its argument depends on — what a callee copies, locks, bounds
or returns — and confirm the claim against that code, not only against the
diff hunk. If you cannot confirm it there, it is at most a suggestion that
says what you could not check.

A blocker you keep from a cross-check goes on its line and lists in checked
each file you opened in {{tree}}/ to confirm it, by its path there. One that
lists none, or a file you did not open, is posted as a suggestion.
