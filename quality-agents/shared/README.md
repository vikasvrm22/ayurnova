# Shared (reserved)

Cross-agent infrastructure for the AyurNova Quality Agent Ecosystem. Empty by
design: nothing here yet, because no two agents currently share a real
contract or utility that would justify centralizing it.

Do not add code here speculatively. A subfolder should only gain content when
a second agent needs the exact same contract/utility that an existing agent
already has, at which point that logic is extracted here and both agents
depend on `shared/`, never on each other.

Subfolders (see each one's README for its intended purpose):

- `contracts/` - cross-agent evidence/finding schema definitions
- `evidence/` - shared evidence-collection primitives
- `severity/` - shared severity/scoring vocabulary (P0-P3 etc.)
- `impact/` - shared blast-radius/impact classification
- `workflows/` - shared workflow-definition format
- `baselines/` - shared baseline storage/comparison format
- `reporting/` - shared report rendering (JSON/Markdown)
- `utils/` - genuinely generic helpers (fs walking, path resolution, etc.)

See [../../docs/quality/AYURNOVA-AGENT-ECOSYSTEM.md](../../docs/quality/AYURNOVA-AGENT-ECOSYSTEM.md)
for the full ecosystem architecture and the independence rule that makes this
layer necessary.
