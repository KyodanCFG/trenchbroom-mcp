# Decisions

## 2026-08-06 — Treat the .map file as the API instead of forking TrenchBroom for a scripting interface
**Decision:** The MCP server reads and writes `.map` files directly. TrenchBroom
is not modified to expose a scripting API.
**Why:** TrenchBroom has no scripting API, no plugin system, no IPC and no CLI.
Adding one means maintaining a fork of a large C++/Qt codebase forever. The
`.map` format is plain text, simple to parse, and TrenchBroom stores its own
concepts (layers, groups, linked groups) as `_tb_*` properties inside it, so an
external tool can round-trip them without touching the editor.
**Rejected:** Embedding an RPC server in a TrenchBroom fork (permanent
maintenance burden); UI automation by screenshot and click (brittle).

## 2026-08-06 — Apply external changes as an edit rather than reloading the map
**Decision:** `mdl::Map::applyExternalChanges()` reads the changed file into a
temporary world, diffs it against the open map, and applies the difference as
one undoable transaction. Reloading is the fallback, not the mechanism.
**Why:** Reloading builds a new map, and the commands on the undo stack point at
nodes that reloading destroys — so the stack cannot be carried over at all. It
is a use-after-free, not a lossy conversion, and no amount of patching the
reload path fixes it. Applying a diff keeps node identity, so the undo stack
stays valid, and it makes the external change itself undoable: Ctrl+Z undoes an
edit made by a script.
**Cost accepted:** Undoing an external change leaves the document deliberately
out of sync with the file on disk, and marked modified.
**Rejected:** Carrying the old command stack across a reload (unsafe);
remapping commands to new nodes (each command type holds different data, no
generic facility exists).

## 2026-08-06 — Match nodes by content, not by position
**Decision:** Nodes are matched between the old and new map by a key derived
from their contents. Position in the file or in the node tree is not used.
**Why:** The file has usually changed by the time we are diffing it. Matching by
position picks the wrong node as soon as anything is inserted before the one
that matters — which silently attributes a selection, or a change, to the wrong
object. Content matching survives insertion anywhere.

## 2026-08-06 — Node keys render the whole contents of a node
**Decision:** A node's key is built from its full contents via the model's own
string rendering, not from a summary of chosen fields.
**Why:** The first version summarized a brush as its bounds plus face count, so
retexturing a brush produced an identical key. The change was read as no change
and silently dropped, leaving the editor showing different geometry from the
file. Anything left out of the key is a change that goes unnoticed, so nothing
is left out. Found by a linked-group test that could not have found it on
purpose.

## 2026-08-06 — Pair changed nodes with a weaker key and swap their contents
**Decision:** After exact-content matching claims the unchanged nodes, the
leftovers are paired by a weaker key that survives the change — an entity's
targetname, else its classname; a group's persistent id — and have their
contents swapped in place rather than being removed and re-added.
**Why:** A node that only changed matched nothing, so it lost its identity along
with its selection and editor state, which is what applying a diff exists to
avoid. A heuristic is safe here because pairing the wrong two nodes produces
the same map; only which node inherits the editor state differs.

## 2026-08-06 — Groups are identified by persistent id, not by name
**Decision:** `identityKey` for a group uses `_tb_id`, falling back to the name.
**Why:** The name is one of the things that can change, and a rename then failed
to match, replacing the group instead of editing it. The id is written to the
map file for every group, so it round-trips and survives everything else about
the group changing.

## 2026-08-06 — Update one member of a link set and let TrenchBroom propagate
**Decision:** When the contents of a linked group change, only one changed
member is compared and updated. Committing the transaction brings the others in
line. Group *name* and *transformation* are per-instance and applied to every
member separately.
**Why:** The map refuses to update more than one member of a link set at once —
correctly, since there would be no way to decide which wins. Using TrenchBroom's
own propagation is what the machinery is designed for, and it means a link set
another program changed inconsistently ends up consistent again. The name/
transformation split was found by a failing test: propagation does not carry
them.
**Left alone:** Adding or removing *members* of a link set still falls back to
reloading. Rare, correct via the fallback, and the worst possible thing to get
wrong.

## 2026-08-06 — Fall back to plain reload whenever applying a change fails
**Decision:** `MapWindow` tries `applyExternalChanges()` and, on any failure,
logs why and calls `reload()`.
**Why:** It bounds the risk of the whole diff approach. The worst case becomes
the behavior TrenchBroom had before the patch, rather than a broken edit.

## 2026-08-07 — A leak is a compile failure, even though the compiler exits 0
**Decision:** `compile_map` reports `success: false` when qbsp reports a leak,
and returns the coordinate the compiler escaped from.
**Why:** ericw-tools reports a leak as a *warning* and exits 0, so exit status
reports a broken build as a success — and vis and light then run on garbage.
The "Reached occupant at (x y z)" coordinate names an entity inside the level
that can see the void, which is the thing needed to fix it.

## 2026-08-07 — Only clean up the log files a compile created
**Decision:** Log files are removed after compiling, but existence is recorded
before the run and pre-existing logs are left alone. `keep_logs` disables the
cleanup. The pointfile is never removed.
**Why:** The logs are litter — everything in them is already parsed out of the
tool output — but a log that was already there belongs to somebody else. The
pointfile is the artifact you load to trace a leak.
