# Encounter package assembler (V0)

`assembleEncounterPackage` is a pure function over a v1 host manifest,
baseline modules, candidate modules, the previous package (when revising), and
an explicit assembly timestamp. It validates those records, reports rejected
candidates, and returns an immutable `ready` package. `freezeEncounterPackage`
accepts only a valid, hash-matching ready package and an explicit timestamp.

## Provider-slot selection

V0 treats every tag in `EncounterModule.provides` as a provider slot. Baseline
modules seed those slots. Compatible candidates are then visited in this stable
order: quality score descending, tier descending, module ID ascending, and
revision descending. A candidate claims each slot for which it outranks the
current provider. A candidate claiming no slot is rejected with the winning
provider and tag. The candidate is also rejected if the resulting selected set
would violate either module's declared conflicts.

The frozen package includes every module that owns at least one winning slot.
That means a higher-ranked body module can replace the baseline body provider,
while a baseline module is retained when it still owns another slot such as
combat. Fallback provenance is set only when a rejected primary's declared
fallback is actually selected; an upgrade that succeeds does not falsely report
its displaced baseline as a used fallback.

## Deliberate V0 limitation

`provides` is a capability list, not an atomic replacement-group contract. A
multi-capability module can therefore remain selected beside a partial upgrade
when it owns an uncovered slot. The greedy slot algorithm does not search for a
globally optimal set or split a module into independently loadable pieces. A
future contract may add explicit replacement groups if that atomicity is needed.
