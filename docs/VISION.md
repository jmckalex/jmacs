# Project Vision

## The Pitch in One Sentence

A Lisp-extensible editor that takes Emacs's deepest ideas seriously — the editor as a living environment, every behaviour modifiable from inside — rebuilt on a clean foundation, written for one person and the few others who'll recognise themselves in it.

## The Organising Principle

*Legibility.* The editor should be comprehensible to the people who use it. Not just open-source in the sense that the code is visible, but comprehensible in the sense that the architecture has a shape you can hold in your head, the language has rules you can state precisely, the layers have clear responsibilities, and the system explains itself when you ask.

Emacs is the most legible large editor we have, but the legibility comes despite forty years of accumulated incidental complexity, not because of it. This editor's legibility comes from architectural choices made deliberately while there's still time to make them clean.

This isn't a feature; it's the criterion that resolves disputes. When two design choices conflict, the one that makes the system more comprehensible wins. When a feature would add power at the cost of conceptual clarity, the feature loses. When an optimisation would obscure how the system works, the optimisation loses until profiling proves it necessary.

## The Aesthetic Commitment

The editor should be beautiful by default. Not configurable into beauty — beautiful when you first open it, with the fonts and colours and spacing chosen by someone with taste. This is the visible manifestation of taking the user's experience seriously from the first second, and it distinguishes this project from every other "I'm building a better Emacs" effort, which defer aesthetics to a hypothetical theming system nobody ever uses well.

Visual quality is architectural; it goes in early and it's owned.

## What the Editor Is For

Editing text, primarily code and prose, by someone who wants to shape their tools rather than accept them. The target user is the person who would have been an Emacs user thirty years ago — someone who finds the boundary between "user" and "developer" of their editor artificial, who wants to write a macro to solve a small annoyance, who keeps a directory of half-finished extensions because that's the natural way to live with software.

The target audience is not a mass audience, and the editor shouldn't pretend to be aimed at one. The vision is *not* "an editor for everyone." It's "an editor for the people who would have built it themselves if they'd had time." If a hundred such people end up using it seriously, the project is a success. If ten do, it's still a success because I'm one of them.

## What It's Not Trying To Do

It's not trying to be VS Code. VS Code is a fine tool aimed at the broad professional-developer audience, and competing with it on that ground is hopeless and uninteresting.

It's not trying to be a research project. There's nothing novel here in the academic sense; the value isn't in the techniques but in the synthesis.

It's not trying to be a productisation play. Commercial viability is irrelevant to whether the project is worth doing.

It's not trying to replace Emacs for existing Emacs users. The compatibility costs would be enormous and the cultural fit awful. This is a successor in spirit, not a continuation in substance.

## Why Now

This editor exists because of where the tooling landscape is in 2026, not despite it. Three things have converged that make the project tractable now in a way it wasn't five years ago:

Tree-sitter has matured into a universal parsing layer, so you don't have to write a separate parser for every language.

LSP has standardised editor-to-language-server communication, so you don't have to write language-specific integration.

AI-assisted coding has compressed the implementation distance between "I know what I want" and "working code" by an order of magnitude.

The editor is what becomes possible when one person with taste can do what previously required a team. That's the moment to build it.

## The Deeper Claim

Editors are not just tools; they're environments in which thought happens. The shape of your editor shapes the shape of your work. An editor that's hostile to extension makes you work around it; an editor that invites extension makes you think *with* it.

Emacs at its best is the latter, which is why its users love it past all reason. The vision is to preserve that quality — the editor as thinking partner — while shedding the parts that make it hard to recommend to anyone you actually like. The legibility principle and the aesthetic commitment are both in service of this: a tool you can think clearly in needs to be clear itself, and needs to be pleasant enough to spend hours inside.

## The Personal Context

This project is not separate from my other work — it's continuous with it. The computational philosophy book argues that the right way to do philosophy now is to build computational models that make arguments concrete and testable. The TROCP component library is the practical embodiment of that argument. JMarkdown is my own writing environment. Folio is my task system. Codify is my code editor. All of these are tools I built because the existing ones didn't fit how I actually work.

The new editor extends this line: a substrate for *all of this work*, a unified Lisp environment in which the computational models, the writing, the code, and the daily editing all happen. The editor isn't a side project from the book; eventually, it's where I write the book.

I'm not building an editor for the world. I'm building the environment in which I'll do the rest of my work for the next decade. The world might benefit; that's incidental. The point is that the tools I use shape the work I do, and the tools available to me in 2026 don't quite fit, and I have the means now to make ones that do.

## Success and Failure

**Success**: I use the editor daily. Three weeks from project start, it's usable for editing its own source code. Three months from start, it's where most of my typing happens. A year from start, I've written significant parts of the computational philosophy book in it. The editor has become part of how I think. A handful of other people are also using it because they happened to want the same thing.

**Failure**: Not "the project never ships" — that's just a deferral. Real failure would be shipping something that works but doesn't feel right, where the architecture is sound but the soul isn't there, where I use it for a few weeks and then quietly go back to Sublime because my own editor was somehow not pleasant to live in.

The way to avoid failure is to never let the dogfooding loop break. If at any point I'm not actually using the editor for real work, that's a fire-alarm signal that something is off.

## The Trajectory Model

JMarkdown is the model for how this project will actually unfold. It started as an annoyance fix (Markdown's default syntax bothered me), became a useful tool (once I added dynamic syntax extensions and JavaScript evaluation), and grew into essential infrastructure (the book production pipeline depends on it).

Notice what that progression *doesn't* look like: it doesn't look like "I had a vision, I executed against it, the vision was realised." It looks like "I built something to scratch an itch, used it, discovered what it could be, and let it grow into its actual purpose." The thing I ended up with isn't the thing I set out to build. It's better, because reality told me what it should be.

The new editor will follow the same trajectory. The plans describe a credible starting shape, but the actual shape it settles into will be determined by months of use. The success criterion isn't "the editor matches the canonical use case I wrote down in week one." It's "the substrate is good enough that when I notice something missing in week six, I can build it in an evening."

This is why the substrate decisions matter most. The Lisp runtime, the buffer model, the rendering layer, the extension architecture — these need to be right because they're hard to change later. Everything built on top of them is allowed to be wrong on first attempt, because revisability is the substrate's job.
