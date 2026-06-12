## Introducing jmacs Lisp

The chapters before this part describe what the editor does. This part
is about the language it is done in. Nearly everything you have used so
far — the cursor commands, the kill ring, the modes, the keys — is
ordinary Lisp in the standard library, and the same language is yours:
the editor will evaluate anything you type at it, immediately, while it
runs. This chapter orients you: what the language is and why it is
shaped the way it is, how it divides the work with JavaScript, the ways
to evaluate code right now, and a first taste of writing some. It
teaches almost no syntax — that begins in *Lisp Data Types* — but by the
end of it you will have a live prompt and a working command you wrote.

> *The editor is a Lisp program that is still running; extending it is
> evaluating more of the program.*

### What jmacs Lisp Is

*jmacs Lisp* is a custom dialect, written for this editor. Its
semantics come from Scheme: lexical scope, a single namespace shared by
functions and variables, and applicative order — arguments are
evaluated, left to right, before a procedure is called. Its data
literals come from Clojure: vectors `[1 2 3]`, maps `{:a 1 :b 2}`, and
self-evaluating keywords like `:name`. It is implemented as a
tree-walking interpreter — about two thousand lines of JavaScript in
`packages/lisp` — running inside the editor's own JavaScript runtime.

Each choice serves an extension language rather than a general-purpose
one. Scheme's semantics were chosen because they are small enough to
state precisely and learn whole; the evaluation rules of this dialect
fit in one chapter of this guide, and *The Evaluation Model* states all
of them. One namespace means the things you name — functions, commands,
settings — are one kind of thing, looked up one way. Applicative order
means code you paste into your configuration behaves the way it reads,
top to bottom, inside out. The Clojure-style literals matter because an
editor's configuration is data: keymaps *are* maps, modes *are* maps,
and a notation in which data reads as plainly as code keeps that
configuration inspectable. And a tree-walking interpreter hosted in
JavaScript is honest about the division of labour: extension code
orchestrates rather than crunches, so the interpreter does not need to
be fast — it needs to be transparent — and values cross the boundary to
the engine without translation, because Lisp numbers, strings and
booleans *are* their JavaScript selves, vectors are arrays, and maps
are JavaScript `Map`s.

### Two Languages, One Editor

jmacs deliberately has two extension languages, with a settled division
between them. Lisp is the customization and macro surface — it is what
gives the editor its character, the language of commands, keymaps,
modes, and your `init.lisp`. JavaScript is the engine: the buffer, the
renderer, the filesystem, the host primitives that Lisp calls when real
work has to happen. The contract binding the two is the important part:
*anything JavaScript implements as a default must be overridable from
Lisp, live, while the editor runs.* When you press `TAB` in a
completing prompt, the host calls a Lisp function to decide the
completions; redefine that function and the very next `TAB` obeys you.
The `kill-view!` primitive destroys a view unconditionally;
the cmd(kill-view) *command* that `C-x k` runs is Lisp, and it is the
Lisp that decides to ask before discarding unsaved work. Mechanism below,
policy above — and the policy layer is always open.

This contract is a course steered between two known wrecks. One is the
Emacs trap: implement everything in the extension language, and the
language's performance and the editor's features become the same
problem. The other is the sealed core: a fast engine configured through
inert settings files, where anything the authors did not anticipate is
impossible. jmacs keeps the engine in JavaScript and the character in
Lisp, and the seam between them is a set of named, documented,
replaceable functions. (Today the bridge runs in one direction — the
host registers JavaScript functions as Lisp primitives; calling
arbitrary JavaScript *from* Lisp is specified but not yet built.)

A second principle shapes the user-facing surface: the editor allows
unusual configurations without encouraging them. The abstractions are
capable rather than constrained — a keymap is a plain map, so nothing
stops you binding every key to the same command; a mode is a plain map,
so nothing stops you building one no file extension will ever select.
The defaults are conventional. The ceiling is not.

### Legibility as the Governing Principle

The principle behind both sections above is *legibility*: the editor
should be governed by rules you can state precisely, and it should be
able to state them to you. The language's irreducible core is
seventeen special forms — `quote`, `quasiquote`, `if`, `define`,
`lambda`, `defmacro`, `begin`, `set!`, `let`, `let*`, `letrec`, `cond`,
`and`, `or`, `try`, `module`, `import` — and everything else, from `+`
to `defcommand`, is a function or macro you can inspect. Inspection is
built in: every procedure defined with a docstring keeps it, and
<a href="reference/lisp-core/doc.html" data-jmacs-doc="doc">doc</a>,
<a href="reference/lisp-core/describe.html" data-jmacs-doc="describe">describe</a>
and `where-defined` hand it back from any prompt. Interactively,
`C-h k` (cmd(describe-key)) names the command behind any keystroke,
`C-h f` (cmd(describe-command)) documents any command by name, and
`C-h d` (`open-manual`) opens the manual you are reading. This guide
leans on that throughout: when a chapter names a function, the editor
itself can tell you more.

### Your First Evaluations

You do not need to set anything up. Four surfaces evaluate Lisp in a
stock jmacs, and you should try each one now.

#### The REPL in the Utility Dock

Press `C-x p` (cmd(toggle-repl)). The utility dock opens at the bottom
of the frame with a `λ ` prompt. Type `(+ 1 2)` and press `Enter`; the
REPL prints `3`. It is not a sandbox — it shares the editor's buffers,
so `(insert! "hello")` types into the document in front of you, at
point. Press `C-x p` again to put the dock away.

#### Inline Evaluation in a Buffer

With the cursor anywhere inside a Lisp form, press `C-RET`
(that is cmd(eval-expression-at-point)): the form *enclosing* point is
evaluated, and the result appears in a pill beside its closing bracket
— green for a value, red for an error. The companion `C-x C-e`
(running cmd(eval-expression-before-point)) evaluates the form whose
closing bracket sits just before point. The running record of these
evaluations is the `*Eval log*` buffer, opened
with cmd(show-eval-log). This is the loop you will live in when writing
anything longer than a line: code stays in a buffer, and you evaluate
definitions in place.

#### Commands from the M-x Palette

Press `M-x` (cmd(execute-command)). A palette opens, fuzzy-matching
over every registered command; type a few letters of `view-list!`,
press `Enter`, and the *View List* panel opens. Every entry in that
palette is a Lisp function that announced itself with `defcommand` —
including, in a few minutes, one of yours.

#### The Seeded scratch.lisp Buffer

A fresh launch seeds a buffer named `scratch.lisp` — switch to it with
`C-x b`. It is highlighted as Lisp because its name ends in `.lisp`,
and it arrives holding a small `factorial` definition: put the cursor
inside it, press `C-RET` to define it, then evaluate `(factorial 10)`
the same way. Any `.lisp` buffer works like this; the scratch buffer is
just one with nothing to lose.

When a piece of code earns permanence, it goes in `init.lisp`, your
configuration file, evaluated at every startup — the file and the
larger shape of Lisp programs are the subject of *Modules and Program
Structure*.

### A Taste of the Language

Open the REPL and paste this — or put it in `scratch.lisp` and `C-RET`
each form. Every line is explained in depth later in the guide; here it
is enough to watch it work.

```lisp
;; A function. The docstring is kept, not discarded — and `define`
;; returns the new name as a symbol, which is what the REPL prints.
(define (shout s)
  "Upcase S and add an exclamation mark."
  (string-append (string-upcase s) "!"))   ; ⇒ shout

(shout "ahoy")                             ; ⇒ "AHOY!"

;; A list, a lambda, and two higher-order staples.
(define words '("to" "be" "or" "not" "to" "be"))   ; ⇒ words

(filter (lambda (w) (> (string-length w) 2)) words) ; ⇒ ("not")

(map shout words)   ; ⇒ ("TO!" "BE!" "OR!" "NOT!" "TO!" "BE!")

;; A command: an ordinary function that M-x knows by name. The
;; (interactive …) clause says its argument comes from a minibuffer
;; prompt.
(defcommand insert-shout (text)
  "Prompt for text and insert it, upcased and emphatic."
  (interactive (string "Shout what? "))
  (insert! (shout text)))

;; The editor kept the docstring; ask for it back.
(doc insert-shout)
; ⇒ "Prompt for text and insert it, upcased and emphatic."
```

Now press `M-x`, type `insert-shout`, and press `Enter`. The minibuffer
asks `Shout what? `; whatever you answer lands in your buffer, upcased,
at point. The command did not stop being a function — `(insert-shout
"quietly")` from the REPL does the same thing — and `C-h f
insert-shout` now shows the documentation you wrote thirty seconds ago,
exactly as it would for a command that shipped with the editor.

### The Road Through This Guide

The rest of this part builds the language up in order, then turns it on
the editor. *Lisp Data Types* catalogues every kind of value — numbers,
strings, symbols, keywords, lists, vectors, maps — with their literals
and their equality rules. *The Evaluation Model* states the precise
rules of evaluation: what evaluates to what, special forms against
ordinary application, quoting, and tail calls. *Functions and Closures*
covers `define` and `lambda`, parameters, docstrings, and what a
closure captures. *Control Flow and Iteration* explains branching and
the iteration toolkit — higher-order functions, the loop macros, named
`let`, and the recursion they stand on. *Errors and
Error Handling* covers signalling with `error` and recovering with
`try`. *Writing Macros* introduces `defmacro`, quasiquote, and the
judgement of when a macro is warranted. *Modules and Program Structure*
covers `module` and `import`, hot reload, and where your code should
live, `init.lisp` included. *Editing Text from Lisp* turns to the
editor proper: buffers, point, mark, region, and undo. *Commands,
Keymaps, and the Minibuffer* gives `defcommand`, key binding, and
prompting their full treatment. *Writing Modes and Hooks* shows how a
language mode is assembled and extended. *Customization from Lisp*
covers settings, faces, and themes as a programming surface. *Lisp
Style and Pitfalls* closes with the conventions the standard library
follows and the traps the unwary fall into.

### Conventions Used in This Guide

Code appears in fenced blocks you can paste into the REPL or evaluate
inline. A trailing comment with `; ⇒` shows an expression's *value*,
and `; prints …` shows its printed *output* — the two are different,
and *The Evaluation Model* makes the distinction precise:

```lisp
(* 6 7)            ; ⇒ 42
(println "hello")  ; prints hello   ⇒ nil
```

Keys are written in the editor's chord notation: `C-` is Control, `M-`
is Command (the Meta of Emacs custom), `A-` is Option, and `S-` is
Shift, so `M-x` is Command+X and `C-x C-e` means Control+X then
Control+E. Named keys such as `RET` and `TAB` are set in capitals in
prose; the lowercase strings Lisp itself uses to name keys (`"enter"`,
`"C-x"`) appear when we write keymaps, in *Commands, Keymaps, and the
Minibuffer*. Function, command and variable names appear in `code
face`; commands are linked to their reference pages, and everything
else can be asked about in the running editor with `(doc …)` or
`C-h .` (cmd(describe-symbol-at-point)).
