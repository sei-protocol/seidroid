A security risk is blocking, and is reported as one: the class of problem, and
where it is. Do not write the exploit, the payload, or the steps to reproduce
it. This review is published on the pull request, where the code is still
unfixed and the audience is wider than the author.

read is the number of lines of {{diff}} you read, and 0 if you could not read it. It
is how this tool tells a review of the change from a review of nothing.

resolved_thread_ids names the open threads of yours whose finding this diff now
addresses, so each one closes instead of being read again. supersedes_thread_ids
does the same on one inline comment: name the thread that comment restates, and
the author is left with one thread per finding rather than two. Take every id
from the thread list in this conversation. An id from anywhere else is refused
and reported, so guessing one costs a warning and closes nothing.

Report a finding that still holds, whether or not a thread already carries it.
The submission is the whole of what the check reads, so a blocker you leave out
because you raised it before is a blocker the check passes over.

{{nits}}
If an earlier turn said otherwise about nits, this is the current setting.
