# Architecture

## Overview

The editor is structured as five layers, each with a clear responsibility and a stable interface to the layers it touches. Dataflow is one-directional: user input becomes commands, commands modify the buffer, buffer changes propagate to the renderer for display. The renderer never modifies state directly.

This document describes the architecture at the level needed to start building. Detailed interface specifications live in `docs/api/` (to be written as the project develops).

## The Five Layers

### L0 — Host Platform

Electron. The main process handles file I/O, subprocess management, native OS integrations, and IPC to the renderer process. Thin and stable. Should rarely change once established.

### L1 — Storage (`packages/storage`)

The text data structure. A rope (or piece tree), with efficient inserts, deletes, range queries, undo/redo, and persistence to disk. Emits low-level edit events on every change.

L1 has no semantic awareness. It doesn't know what a buffer *means*, only what characters are in it. Position units are character positions, zero-indexed, half-open ranges.

Recommended implementation: wrap CodeMirror 6's `@codemirror/state` Text class if it extracts cleanly; otherwise implement a piece tree from scratch. The piece tree is a few hundred lines of careful code, not a multi-week project.

### L2 — Buffer / Semantic Model (`packages/buffer`)

The conceptual heart of the editor. Wraps L1 and adds:

- **Text properties**: arbitrary metadata attached to character ranges (faces for syntax highlighting, semantic categories, link targets, fold markers)
- **Overlays**: ranges with attached metadata, distinct from text properties primarily in lifecycle — text properties travel with characters under copy/paste; overlays exist independent of buffer content
- **Markers**: positions in a buffer that update correctly as the buffer is edited
- **Point and mark**: cursor position and selection anchor
- **Modes**: tagged behavioural configuration for a buffer (major mode + minor modes)
- **Hooks**: places where extensions can attach handlers (before/after change, mode activation, buffer creation)
- **Undo groups**: command-level transactions over L1's lower-level undo

L2 is the API that Lisp and JavaScript extensions talk to. It's the system's nervous system; almost every interesting operation goes through it.

L2 emits rich change events that consumers (like L4) can use to update incrementally without re-querying state. See `docs/api/events.md` (to be written) for the event schema.

### L3 — Lisp Runtime (`packages/lisp`)

A Lisp interpreter written from scratch in vanilla JavaScript. Tree-walking interpreter for the initial version; bytecode VM is a later optimisation if needed.

The Lisp is a custom dialect, designed for this editor. Influences are primarily Scheme (semantics, modules) and Clojure (data structures, idiom), with Common Lisp's condition system as the underlying error-handling machinery.

Core design decisions (detailed in `docs/spec/lisp.md` once written):

- Lexical scoping by default
- Immutable persistent data structures as default
- Hygienic macros (syntax-case style)
- First-class modules with explicit imports/exports
- Conditions/restarts as underlying error machinery, try/catch as everyday surface
- Self-documenting: every definition preserves source location and docstring metadata
- Hot reload: redefining a module updates definitions in the running editor

L3 exposes host primitives that wrap the L2 API as the standard module `editor.buffer`. This is what extensions actually call when manipulating buffers.

### L4 — Renderer / Presentation (`packages/renderer`)

The Electron renderer process. Subscribes to L2 events, projects buffer state into the DOM, handles input events, manages viewport.

Key implementation choices:

- **Virtualisation**: only visible lines exist in the DOM. Scrolling adds/removes line elements as needed
- **Run-based rendering**: each line is divided into runs (maximal stretches of characters sharing the same properties), one span per run. Not per-character spans
- **Animation-frame batching**: dirty-mark on event arrival, render on next `requestAnimationFrame`. One render per frame regardless of event volume
- **Tree-sitter for syntax highlighting**: parses buffer content into a real syntax tree, queries tag nodes with highlight categories, results stored as text properties on L2
- **Plain DOM for the editor surface**: React adds too much overhead per span. React (or similar) for chrome (modeline, command palette) is fine

The renderer never mutates L2 directly. Input dispatches commands; commands modify L2; L2 events flow back to drive rendering.

## Dual Scripting

The editor exposes two extension languages: Lisp (the primary, what gives the editor its character) and JavaScript (also first-class, because we're already in a JS runtime and denying access would be silly).

Both languages have full access to the L2 API. The Lisp surface uses kebab-case names and idiomatic Lisp conventions. The JavaScript surface uses camelCase and idiomatic JS conventions. Both bind to the same underlying L2 operations.

The standard library and the editor's own commands are in Lisp. This gives the editor coherent character — Lisp is the canonical extension idiom — while JavaScript is available for cases where it's a better fit (web library integration, rapid prototyping, code that's naturally web-shaped).

Both languages share the editor's runtime state: there's one set of buffers, one set of commands, one set of modes. A command registered in JavaScript is callable from Lisp and vice versa. Each language has its own evaluation model and namespace; they meet at the shared L2 API.

## Cross-Cutting Concerns

### Standard Library (`packages/stdlib`)

Lisp code that ships with the editor. The commands users actually invoke (find-file, save-buffer, forward-word, kill-region, etc.) are defined here, in Lisp, on top of L2 primitives.

### Build and Release

Vite for the renderer, electron-builder for packaging. pnpm workspaces for the monorepo. ESM modules throughout. No TypeScript — vanilla JavaScript with JSDoc for public API documentation.

### Future Layers (Deferred)

- **LSP client** (`packages/lsp`, week 4+): Language Server Protocol client for diagnostics, completions, hover, etc.
- **Package system** (`packages/packages`, week 5+): Extension distribution, dependency resolution, capability-based permissions.

## What the Architecture Is Not

It's not Emacs-compatible. The Lisp is its own language, not Elisp. Extensions written for Emacs do not run here. This is deliberate — Emacs compatibility would require carrying decades of accumulated baggage that the project explicitly chooses to leave behind.

It's not aiming at cross-platform from day one. macOS works; Linux and Windows are deferred until the macOS version is stable.

It's not multi-window or collaborative. One window with multiple buffers. Real-time collaboration is out of scope.

It's not aiming at the broad developer audience. The target user knows what Emacs is and considers shaping their own tools normal.

## Where the Decisions Compound

A few design choices that are expensive to change later, so they need to be right:

The L2 API surface. Every extension depends on it. Once it's stable, changes ripple through everything. Design carefully, document explicitly.

The Lisp's scoping, macro hygiene, and module semantics. These affect how all extensions are written and can't be modified without breaking existing code. Take time on these in the spec.

The change event protocol between L2 and L4. Performance and correctness both depend on it. Define schemas precisely with examples.

The dual-language interop story. How Lisp calls JavaScript and vice versa. Value conversion at the boundary. Settled once and stable.

## Where the Decisions Don't Compound

Almost everything else is revisable without breaking things downstream:

The renderer's internal implementation. The projection function, viewport management, virtualisation strategy — all replaceable behind the L2 subscription interface.

The Lisp's standard library and bundled modes. These can grow and change as the editor matures.

The visual design. Themes, fonts, chrome layout — all owned by L4 and changeable independently.

Specific commands, keybindings, command palette behaviour. These are stdlib concerns, written in Lisp, easily revised.

The architecture protects revisability where it matters by keeping the interfaces between layers stable and the implementations behind those interfaces free.
