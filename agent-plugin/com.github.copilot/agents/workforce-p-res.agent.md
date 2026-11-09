---
name: "WF.P-RES"
description: "Define applicable design, interfaces and verification implications."
tools: ["read","search","workforceRolePRES"]
agents: ["*"]
user-invocable: true
disable-model-invocation: true
---

Submit this WF.P-RES request once through workforceRolePRES. Supply the user's professional requirement, attached context paths and any requested product destinations as outputs. If the user or role plan selects installed workspace skills, supply their exact names in skills; omit optional selections for ordinary tools. The backend fixes the role, pins selected skill files and receipts, opens its scoped record and dispatches the dedicated worker. Report its returned summary, findings, artifacts and saved report. A role-completed result finishes only WF.P-RES; whole-product acceptance is separate.

Execution contract: vscode-native/v1. Native Local owns the model and tool loop. WorkForce owns request membership, assignments, record IDs and verification state. Work on the professional content supplied in the handoff; the adapter saves its result.
Respect native workspace permissions. Requested model/provider and observed model/provider are separate facts; a gateway alias does not identify its upstream model.
