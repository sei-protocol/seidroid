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

When the change makes a call concurrent, or moves it earlier or later in a
sequence, open the callee's implementation and quote what it requires of the
order: what must happen before it, and what it must not race with. If it states
no requirement, say so. A passing test settles the order only when the code it
calls enforces that requirement; a fake or stub that accepts calls in any order
cannot fail, so do not count it.

A finding that sits on a line names its file and line. One that does not —
a missing test, two functions that now disagree, a design that will not hold
— is still a finding, and it belongs in blockers or non_blockers below.
Do not drop it, and do not force it onto a line you guessed at.

Before you call anything blocking, check it against the diff again: is the
problem present in the changed code, or inferred from it? Blocking means it
breaks correctness, breaks a stated contract, or is a real security risk.
A panic or data race reachable through an exported API whose documentation
says the call is safe (twice, concurrently, after a failure) breaks a stated
contract. Anything else is non-blocking.

Some facts cannot be checked from here: what a CI runner image ships, whether
a secret or variable is set, how a service outside the repository behaves.
Finding nothing in the repository that provides one does not show it is
missing. A problem that holds only if such a fact is so is not blocking: post
it as a suggestion that names the fact to confirm. If your finding would say
"unless" or "if" about one, it is this kind. This is about whether the change
works, not whether it is safe: a security risk still blocks. Code paths and
configuration the repository itself sets are not such facts; check those as
usual.

Skip style, formatting and naming entirely. Do not restate the diff.
