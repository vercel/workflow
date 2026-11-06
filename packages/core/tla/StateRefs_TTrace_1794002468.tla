---- MODULE StateRefs_TTrace_1794002468 ----
EXTENDS Sequences, TLCExt, Toolbox, Naturals, TLC, StateRefs

_expression ==
    LET StateRefs_TEExpression == INSTANCE StateRefs_TEExpression
    IN StateRefs_TEExpression!expression
----

_trace ==
    LET StateRefs_TETrace == INSTANCE StateRefs_TETrace
    IN StateRefs_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        broken = ({<<"cold step: recovery fails", 2>>})
        /\
        parent = (<<0, 1, 0, 0>>)
        /\
        opaque = (<<FALSE, TRUE, FALSE, FALSE>>)
        /\
        known = ({1, 2})
        /\
        held = ({1, 2})
        /\
        log = (<<[t |-> "out", s |-> 0, kind |-> "full", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 1, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 2, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "out", s |-> 1, kind |-> "patch", v |-> 2, base |-> 1, src |-> {}, delivered |-> TRUE]>>)
        /\
        srcs = ({})
        /\
        steps = (<<[st |-> "done", in |-> 1], [st |-> "created", in |-> 1], [st |-> "none", in |-> 0]>>)
        /\
        seen = ({"ref input", "patch output"})
        /\
        nextV = (3)
    )
----

_init ==
    /\ seen = _TETrace[1].seen
    /\ nextV = _TETrace[1].nextV
    /\ srcs = _TETrace[1].srcs
    /\ opaque = _TETrace[1].opaque
    /\ parent = _TETrace[1].parent
    /\ held = _TETrace[1].held
    /\ steps = _TETrace[1].steps
    /\ broken = _TETrace[1].broken
    /\ known = _TETrace[1].known
    /\ log = _TETrace[1].log
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ seen  = _TETrace[i].seen
        /\ seen' = _TETrace[j].seen
        /\ nextV  = _TETrace[i].nextV
        /\ nextV' = _TETrace[j].nextV
        /\ srcs  = _TETrace[i].srcs
        /\ srcs' = _TETrace[j].srcs
        /\ opaque  = _TETrace[i].opaque
        /\ opaque' = _TETrace[j].opaque
        /\ parent  = _TETrace[i].parent
        /\ parent' = _TETrace[j].parent
        /\ held  = _TETrace[i].held
        /\ held' = _TETrace[j].held
        /\ steps  = _TETrace[i].steps
        /\ steps' = _TETrace[j].steps
        /\ broken  = _TETrace[i].broken
        /\ broken' = _TETrace[j].broken
        /\ known  = _TETrace[i].known
        /\ known' = _TETrace[j].known
        /\ log  = _TETrace[i].log
        /\ log' = _TETrace[j].log

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("StateRefs_TTrace_1794002468.json", _TETrace)

=============================================================================

 Note that you can extract this module `StateRefs_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `StateRefs_TEExpression.tla` file takes precedence 
  over the module `StateRefs_TEExpression` below).

---- MODULE StateRefs_TEExpression ----
EXTENDS Sequences, TLCExt, Toolbox, Naturals, TLC, StateRefs

expression == 
    [
        \* To hide variables of the `StateRefs` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        seen |-> seen
        ,nextV |-> nextV
        ,srcs |-> srcs
        ,opaque |-> opaque
        ,parent |-> parent
        ,held |-> held
        ,steps |-> steps
        ,broken |-> broken
        ,known |-> known
        ,log |-> log
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_seenUnchanged |-> seen = seen'
        
        \* Format the `seen` variable as Json value.
        \* ,_seenJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(seen)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_seenModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].seen # _TETrace[s-1].seen
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE StateRefs_TETrace ----
\*EXTENDS IOUtils, TLC, StateRefs
\*
\*trace == IODeserialize("StateRefs_TTrace_1794002468.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE StateRefs_TETrace ----
EXTENDS TLC, StateRefs

trace == 
    <<
    ([broken |-> {},parent |-> <<0, 0, 0, 0>>,opaque |-> <<FALSE, FALSE, FALSE, FALSE>>,known |-> {1},held |-> {1},log |-> <<[t |-> "out", s |-> 0, kind |-> "full", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE]>>,srcs |-> {},steps |-> <<[st |-> "none", in |-> 0], [st |-> "none", in |-> 0], [st |-> "none", in |-> 0]>>,seen |-> {},nextV |-> 2]),
    ([broken |-> {},parent |-> <<0, 0, 0, 0>>,opaque |-> <<FALSE, FALSE, FALSE, FALSE>>,known |-> {1},held |-> {1},log |-> <<[t |-> "out", s |-> 0, kind |-> "full", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 1, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE]>>,srcs |-> {},steps |-> <<[st |-> "created", in |-> 1], [st |-> "none", in |-> 0], [st |-> "none", in |-> 0]>>,seen |-> {"ref input"},nextV |-> 2]),
    ([broken |-> {},parent |-> <<0, 0, 0, 0>>,opaque |-> <<FALSE, FALSE, FALSE, FALSE>>,known |-> {1},held |-> {1},log |-> <<[t |-> "out", s |-> 0, kind |-> "full", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 1, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 2, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE]>>,srcs |-> {},steps |-> <<[st |-> "created", in |-> 1], [st |-> "created", in |-> 1], [st |-> "none", in |-> 0]>>,seen |-> {"ref input"},nextV |-> 2]),
    ([broken |-> {},parent |-> <<0, 1, 0, 0>>,opaque |-> <<FALSE, TRUE, FALSE, FALSE>>,known |-> {1, 2},held |-> {1, 2},log |-> <<[t |-> "out", s |-> 0, kind |-> "full", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 1, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 2, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "out", s |-> 1, kind |-> "patch", v |-> 2, base |-> 1, src |-> {}, delivered |-> TRUE]>>,srcs |-> {},steps |-> <<[st |-> "done", in |-> 1], [st |-> "created", in |-> 1], [st |-> "none", in |-> 0]>>,seen |-> {"ref input", "patch output"},nextV |-> 3]),
    ([broken |-> {<<"cold step: recovery fails", 2>>},parent |-> <<0, 1, 0, 0>>,opaque |-> <<FALSE, TRUE, FALSE, FALSE>>,known |-> {1, 2},held |-> {1, 2},log |-> <<[t |-> "out", s |-> 0, kind |-> "full", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 1, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "in", s |-> 2, kind |-> "ref", v |-> 1, base |-> 0, src |-> {}, delivered |-> TRUE], [t |-> "out", s |-> 1, kind |-> "patch", v |-> 2, base |-> 1, src |-> {}, delivered |-> TRUE]>>,srcs |-> {},steps |-> <<[st |-> "done", in |-> 1], [st |-> "created", in |-> 1], [st |-> "none", in |-> 0]>>,seen |-> {"ref input", "patch output"},nextV |-> 3])
    >>
----


=============================================================================

---- CONFIG StateRefs_TTrace_1794002468 ----
CONSTANTS
    MaxVersions = 4
    MaxSteps = 3
    MaxHooks = 1
    BodyLineage = FALSE
    Opaque = TRUE
    OpaquePlain = FALSE
    Undelivered = FALSE
    FilterHooks = FALSE

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Fri Nov 06 22:01:09 UTC 2026