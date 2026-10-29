# WorkForce

WorkForce turns ordinary engineering requests into deliverables with traceable requirements, applicable design, independent review and verification. The same saved request connects client chat, runtime-owned agents and the WorkForce Universe.

## Language

### Requests and execution

**Request**:
The public unit of work: original user intent and supplied context, together with its saved engineering contract, progress and deliverables. An intentional new request remains distinct from a retry or continuation of an existing request.
_Avoid_: Using a similar historical request as the identity of new work.

**Request contract**:
The agreed scope, outputs, acceptance criteria, applicable design and verification obligations for one request. Its traceability connects each criterion to the relevant artifact revision, evidence and review disposition.

**Task**:
A bounded engineering assignment within a request, with an owner, authorized outputs, acceptance criteria and links to the requirements and design it addresses.

**WorkForce runtime**:
The owner of request state, engineering identities, scoped tool bindings, scheduling, recovery and final acceptance. Client chats submit or follow requests; workers contribute professional results under runtime-owned assignments.

**Engine session**:
A worker conversation managed by the pinned OpenCode engine through its SDK. The engine owns its model and tool-call loop and conversation identities; WorkForce owns engineering identities and state.

**Agent assignment**:
A bounded responsibility delegated to an actual actor under a declared profile and core role. An assignment description establishes scope; observed execution and its receipt establish what actually ran.

**Invocation receipt**:
A provenance-bearing record of an invocation's bound context, lifecycle and requested or observed model identifiers. Receipt creation, completed inference, a substantive result and engineering acceptance are separate facts.

### Team

**Agent profile**:
A named set of duties presented to a client or worker. A visible profile can compose existing core responsibilities; its presence alone does not establish an active agent.

**Core role**:
A stable responsibility used for engineering ownership, permitted operations and model policy. Profile names do not replace core role identifiers.

**WF.PM**:
The coordination responsibility for planning, applicable reuse, bounded delegation, recovery decisions and final handoff. The client WF.PM is an intake and follow-up profile; runtime WF.PM owns engineering coordination.

**WF.SWSD**:
The responsibility for scope, measurable requirements, acceptance criteria and verification intent.

**WF.P-RES**:
The responsibility for applicable architecture, interfaces, module design, constraints and design risks.

**WF.FnD**:
The responsibility for implementation, producer tools, self-checks and repairs to product artifacts. Its self-checks are distinct from independent review and verification.

**WF.Reviewer**:
The independent responsibility for assessing specifications, applicable design, implementation and standards, with explicit findings and disposition.

**WF.Tester**:
The independent responsibility for expected outcomes, checker validity, applicable test execution and verification evidence. Checker repair belongs to this responsibility; product repair belongs to WF.FnD.

### Progress and assurance

**V-model**:
The relationship between requirements and design on one side and their corresponding verification levels on the other. Applicable levels and justified non-applicability depend on the product; this traceability is not an ASPICE capability certification.

**WorkForce Universe**:
The request-oriented V-model view of actual engineering progress, responsible agents, deliverables, findings and controls. Configured roles and historical activity remain distinct from current execution.

**Artifact revision**:
The particular contents of a delivered product or checker to which an observation applies. A changed artifact requires an assessment of whether its earlier evidence remains applicable.

**Evidence**:
An observation associated with its method, inputs, output and limitations. A configured operation, requested model or proposed check is distinct from an observed execution.

**Acceptance**:
The backend's assessment that the current deliverable revision satisfies its saved criteria and applicable review and verification obligations. Agent declarations, existing files and historical passes alone do not establish acceptance.

**Technical incident**:
An unresolved execution, tool, protocol, provider or environment problem owned by the system. It preserves unfinished work and is distinct from a missing product decision.

**Product question**:
A specific missing user decision, source or clarification whose absence affects an acceptance criterion. Its answer supplements and continues the same request.

### Reuse and knowledge

**Recipe**:
A versioned, parameterized procedure with an applicability contract, generator and verification expectations.

**Recipe instance**:
A recipe bound to particular parameters, engineering inputs and outputs. A new instance does not inherit historical execution results as current evidence.

**Registered procedure**:
A project script and independent check with an immutable version, parameter/output contract, declared effects and environment. Registration creates a candidate rather than proving safe automatic reuse.

**Qualified procedure**:
A registered version whose review and actual checked runs establish eligibility under its declared applicability and execution conditions. Eligibility is distinct from permission for a particular execution and from evidence for its new outputs.

**Procedure match**:
An advisory applicability assessment against the current request and contract. Retrieval similarity alone does not establish qualification, current applicability or execution permission.

**Work record**:
An actor's substantive account of its objective, inputs, decisions, results, evidence, limitations and lessons.

**Cornell note**:
A source-linked learning artifact with cues, narrative, a demonstration and separate practice and answers. It is distinct from the work record describing an actor's assignment.

**Knowledge source**:
A provenance-bearing project or upstream artifact consulted for applicability. Retrieval similarity does not establish compatibility, authority to execute, or approval to publish.

### Legacy compatibility

**Workflow**:
The persisted execution increment underlying a request or a historical NeoMind operation, with its original identities, mode, assignments, decisions and completion conditions. Rebranding its presentation does not replace its saved contract or rewrite its history.
_Avoid_: Using legacy workflow controls as the ordinary WorkForce request interface.

**Reported local identity**:
A legacy unsigned identity for attributing participation when a native client does not expose an invocation identity. It is distinct from a signed invocation receipt and from an activity correlation key.

**Activity report**:
A reported observation of assignment progress, retained for compatible historical attribution. Activity alone is distinct from execution evidence and engineering acceptance.

**Lightweight workflow**:
A legacy unsigned native increment using a compact, risk-based checkpoint contract. It is distinct from full engineering acceptance and cannot replace the commitments of a saved strict increment.
