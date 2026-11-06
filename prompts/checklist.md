Step 2 — review the changed code. In the changed lines and what they call
into, look for:

- an unhandled error, a nil dereference, an off-by-one, an inverted condition
- a goroutine with no exit path, a send with no reader, a lock held across a
  blocking call, a context that is never cancelled
- an external call with no timeout, or a retry of something not idempotent
- non-determinism where every node has to agree: map iteration order, a
  wall-clock read, randomness, unordered serialisation
- injection, an authorisation bypass, an exposed secret, unsafe
  deserialisation, path traversal, SSRF, or anything that weakens a boundary
  the code already has

A finding that sits on a line names its file and line. One that does not —
a missing test, two functions that now disagree, a design that will not hold
— is still a finding, and it belongs in blockers or non_blockers below.
Do not drop it, and do not force it onto a line you guessed at.

Before you call anything blocking, check it against the diff again: is the
problem present in the changed code, or inferred from it? Blocking means it
breaks correctness, breaks a stated contract, or is a real security risk.
Anything else is non-blocking.

Skip style, formatting and naming entirely. Do not restate the diff.
