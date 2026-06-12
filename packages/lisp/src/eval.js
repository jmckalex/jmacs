/**
 * @file The evaluator — a tree-walking interpreter for the editor's
 * Lisp. Applicative order, left-to-right argument evaluation, lexical
 * scoping.
 *
 * Special forms are the irreducible core (`if`, `define`, `lambda`,
 * `quote`, `let`, …); everything else is a procedure or a macro.
 * Macros are procedural — a macro is a procedure from source forms to a
 * source form — and so are *not* hygienic; that is a deliberate, noted
 * v0 limitation (see docs/spec/lisp.md).
 *
 * Tail calls run in constant stack via a trampoline: `evaluate` is a
 * loop, and a call in tail position returns a `TailCall {form, env}`
 * thunk that the loop bounces instead of recursing. So deeply
 * tail-recursive Lisp (the idiomatic way to walk a list) does not grow
 * the JavaScript stack. NON-tail recursion still does — e.g. building a
 * result by recursing inside an argument, `(cons x (f …))` or
 * `(str line (f …))` — because the inner call is not in tail position;
 * those few hot spots are written iteratively (or with host primitives)
 * instead.
 */

import { Environment } from './environment.js';
import {
  arrayToList,
  isTruthy,
  keyword,
  Lambda,
  LispError,
  LispMacro,
  list,
  listToArray,
  NIL,
  Pair,
  Primitive,
  sourceLocations,
  Sym,
  sym,
  writeString,
} from './values.js';

/**
 * A deferred tail call. Internal helpers in tail position return one of
 * these instead of recursing through `evaluate`; the `evaluate` loop
 * bounces it (reassigns `form`/`env` and continues), so tail recursion
 * runs in constant JavaScript stack. It never escapes to callers — the
 * public `evaluate` / `applyProcedure` always bounce to a real value.
 */
class TailCall {
  constructor(form, env) {
    this.form = form;
    this.env = env;
  }
}

/**
 * The source location `{line, col}` of the innermost located form the
 * evaluator has entered. Updated as `evaluate` descends (see
 * `evaluateForm`); read at a catch boundary to tag a LispError with where
 * it was raised. A throw unwinds the JS stack without evaluating more
 * forms, so this still holds the offending form when the catch reads it.
 */
let currentLocation = null;

/**
 * Tag a LispError with the source location of the form that was executing
 * when it was raised — unless it already carries one, so the innermost
 * frame wins. Called at the catch boundaries (the host interpreter and the
 * `try` special form) so an error surfaces *where* as well as *what*.
 *
 * @param {*} error - The caught value (only LispErrors are tagged).
 * @returns {*} the same value, for `throw attachErrorLocation(e)`.
 */
export function attachErrorLocation(error) {
  if (error instanceof LispError && error.location == null && currentLocation) {
    error.location = currentLocation;
  }
  return error;
}

/**
 * Clear the location tracker before a fresh top-level evaluation, so a
 * stale location from a previously-evaluated form can't mislabel an error
 * raised before any located form in the new one runs.
 */
export function resetErrorLocation() {
  currentLocation = null;
}

/**
 * Evaluate a form in an environment.
 * @param {*} form
 * @param {Environment} env
 * @returns {*}
 */
export function evaluate(form, env) {
  // The trampoline: each iteration either returns a value or rebinds
  // `form`/`env` from a TailCall and loops, instead of recursing.
  for (;;) {
    // Symbols are variable references.
    if (form instanceof Sym) {
      return env.lookup(form.name);
    }
    // Lists are special forms, macro uses, or procedure applications.
    if (form instanceof Pair) {
      const result = evaluateForm(form, env);
      if (result instanceof TailCall) {
        form = result.form;
        env = result.env;
        continue;
      }
      return result;
    }
    // Vectors and maps evaluate their elements.
    if (Array.isArray(form)) {
      return Object.freeze(form.map((element) => evaluate(element, env)));
    }
    if (form instanceof Map) {
      const result = new Map();
      for (const [key, value] of form) {
        result.set(evaluate(key, env), evaluate(value, env));
      }
      return result;
    }
    // Everything else — numbers, strings, booleans, keywords, nil,
    // procedures — is self-evaluating.
    return form;
  }
}

/** Evaluate a non-empty list form. */
function evaluateForm(form, env) {
  // Record where we are for error reporting (B6): the innermost located
  // form being evaluated. Cheap — one WeakMap.get per list form, with no
  // try/catch in the trampoline, so tail-call performance is untouched.
  const location = sourceLocations.get(form);
  if (location !== undefined) currentLocation = location;

  const head = form.head;

  if (head instanceof Sym) {
    const special = SPECIAL_FORMS[head.name];
    if (special !== undefined) {
      return special(form, env);
    }
    if (env.has(head.name)) {
      const binding = env.lookup(head.name);
      if (binding instanceof LispMacro) {
        const expanded = applyProcedure(
          binding.transformer,
          listToArray(form.tail)
        );
        // An error in the expansion belongs to the macro *use* site, not
        // wherever the transformer last looked — re-stamp before bouncing.
        if (location !== undefined) currentLocation = location;
        // A macro use evaluates to its expansion, in tail position.
        return new TailCall(expanded, env);
      }
    }
  }

  const procedure = evaluate(head, env);
  const args = listToArray(form.tail).map((arg) => evaluate(arg, env));
  // Evaluating the args moved `currentLocation` to the last argument; an
  // error from the application itself (arity, not-a-procedure, a throwing
  // primitive) belongs to this call form, so re-stamp before applying.
  if (location !== undefined) currentLocation = location;
  // Tail position: `applyTail` may return a TailCall (Lambda body) that
  // the `evaluate` loop bounces; a Primitive returns its value directly.
  return applyTail(procedure, args);
}

/**
 * Apply a procedure to already-evaluated arguments, returning a finished
 * value. This is the public entry — `interpreter.call`, the host, and
 * higher-order primitives (`map`/`filter`/`reduce`/`apply`) use it — so
 * it bounces any tail call and callers never see a `TailCall`.
 * @param {*} procedure
 * @param {*[]} args
 * @returns {*}
 */
export function applyProcedure(procedure, args) {
  const result = applyTail(procedure, args);
  return result instanceof TailCall
    ? evaluate(result.form, result.env)
    : result;
}

/**
 * Apply a procedure in TAIL position. A Primitive returns its value
 * directly; a Lambda runs its body's earlier forms and returns a
 * `TailCall` for the last form, which the `evaluate` loop bounces — so a
 * tail call (including self-recursion) does not grow the JS stack.
 */
function applyTail(procedure, args) {
  if (procedure instanceof Primitive) {
    // The host boundary: a JS primitive that returns `undefined` (falls
    // off the end, bare `return;`) or `null` means "nothing" — both
    // become nil, so Lisp never sees a raw JS null/undefined.
    return procedure.fn(args) ?? NIL;
  }
  if (procedure instanceof Lambda) {
    const env = new Environment(procedure.env);
    bindParameters(procedure, args, env);
    return evaluateBodyTail(procedure.body, env);
  }
  throw new LispError(`not a procedure: ${writeString(procedure)}`);
}

/** Bind a lambda's parameters to its arguments in a fresh frame. */
function bindParameters(lambda, args, env) {
  const { params, rest, name } = lambda;
  if (rest === null && args.length !== params.length) {
    throw new LispError(
      `${name}: expected ${params.length} argument(s), got ${args.length}`
    );
  }
  if (rest !== null && args.length < params.length) {
    throw new LispError(
      `${name}: expected at least ${params.length} argument(s), got ${args.length}`
    );
  }
  params.forEach((param, i) => env.define(param.name, args[i]));
  if (rest !== null) {
    env.define(rest.name, arrayToList(args.slice(params.length)));
  }
}

/** Evaluate body forms in sequence, returning the last result. Eager:
 *  used where a tail call must NOT escape — a `try` body (it sits inside
 *  the JS try/catch, which must stay on the stack) and a module body. */
function evaluateBody(body, env) {
  let result = NIL;
  for (const form of body) {
    result = evaluate(form, env);
  }
  return result;
}

/** Evaluate a body in TAIL position: run every form but the last eagerly,
 *  then return a `TailCall` for the last form so the `evaluate` loop
 *  bounces it (constant stack). An empty body is nil. Used by lambda
 *  bodies and the tail-position special forms (begin / let* / cond / …). */
function evaluateBodyTail(body, env) {
  if (body.length === 0) return NIL;
  for (let i = 0; i < body.length - 1; i += 1) {
    evaluate(body[i], env);
  }
  return new TailCall(body[body.length - 1], env);
}

/**
 * Parse a lambda parameter specification into required params and an
 * optional rest parameter. Accepts `(a b c)`, `(a b . rest)`, a bare
 * symbol (all arguments), or `()`.
 */
function parseParameters(spec) {
  if (spec instanceof Sym) return { params: [], rest: spec };
  if (spec === NIL) return { params: [], rest: null };
  const params = [];
  let node = spec;
  while (node instanceof Pair) {
    if (!(node.head instanceof Sym)) {
      throw new LispError('parameter names must be symbols');
    }
    params.push(node.head);
    node = node.tail;
  }
  if (node === NIL) return { params, rest: null };
  if (node instanceof Sym) return { params, rest: node };
  throw new LispError('malformed parameter list');
}

/** Render a parameter spec back to a list, for `describe`. */
function parametersToList(params, rest) {
  return arrayToList(params, rest === null ? NIL : rest);
}

export { parametersToList };

// --- quasiquote ---------------------------------------------------------

/** Whether `form` is `(tag x)`. */
function isTagged(form, tag) {
  return (
    form instanceof Pair &&
    form.head instanceof Sym &&
    form.head.name === tag &&
    form.tail instanceof Pair &&
    form.tail.tail === NIL
  );
}

/** Expand a quasiquote template. */
function quasiquote(template, env, depth) {
  if (isTagged(template, 'unquote')) {
    if (depth === 1) return evaluate(template.tail.head, env);
    return list(sym('unquote'), quasiquote(template.tail.head, env, depth - 1));
  }
  if (isTagged(template, 'quasiquote')) {
    return list(
      sym('quasiquote'),
      quasiquote(template.tail.head, env, depth + 1)
    );
  }
  if (template instanceof Pair) {
    const items = [];
    let node = template;
    while (node instanceof Pair) {
      if (isTagged(node, 'unquote') && depth === 1) {
        // A dotted unquote tail: `(a . ,rest)
        return arrayToList(items, evaluate(node.tail.head, env));
      }
      const element = node.head;
      if (isTagged(element, 'unquote-splicing') && depth === 1) {
        for (const spliced of listToArray(evaluate(element.tail.head, env))) {
          items.push(spliced);
        }
      } else {
        items.push(quasiquote(element, env, depth));
      }
      node = node.tail;
    }
    const tail = node === NIL ? NIL : quasiquote(node, env, depth);
    return arrayToList(items, tail);
  }
  if (Array.isArray(template)) {
    const items = [];
    for (const element of template) {
      if (isTagged(element, 'unquote-splicing') && depth === 1) {
        for (const spliced of listToArray(evaluate(element.tail.head, env))) {
          items.push(spliced);
        }
      } else {
        items.push(quasiquote(element, env, depth));
      }
    }
    return Object.freeze(items);
  }
  if (template instanceof Map) {
    const result = new Map();
    for (const [key, value] of template) {
      result.set(
        quasiquote(key, env, depth),
        quasiquote(value, env, depth)
      );
    }
    return result;
  }
  return template;
}

// --- special forms ------------------------------------------------------

/** Arguments of a form, as an array. */
function args(form) {
  return listToArray(form.tail);
}

/**
 * Find the module registry, which lives on the root environment. The
 * interpreter installs it; `module` and `import` reach it from any
 * environment by walking out to the root.
 *
 * @returns {{ registry: Map<string, *>, base: Environment }}
 */
function moduleRegistry(env) {
  let root = env;
  while (root.parent !== null) {
    root = root.parent;
  }
  if (root.modules === undefined) {
    throw new LispError('the module system is not available');
  }
  return { registry: root.modules, base: root };
}

/** Build the Lisp value a `catch` clause binds for a caught error. */
function conditionValue(error) {
  const condition = new Map();
  condition.set(keyword('message'), error.lispMessage ?? error.message);
  condition.set(keyword('irritants'), arrayToList(error.irritants ?? []));
  // Surface the source location (B6) so a Lisp catch handler can report
  // *where* the error came from, not just its message.
  if (error.location) {
    condition.set(keyword('line'), error.location.line);
    condition.set(keyword('column'), error.location.col);
  }
  return condition;
}

/** @type {Record<string, (form: Pair, env: Environment) => *>} */
const SPECIAL_FORMS = {
  quote(form) {
    return form.tail.head;
  },

  quasiquote(form, env) {
    return quasiquote(form.tail.head, env, 1);
  },

  if(form, env) {
    const parts = args(form);
    if (parts.length < 2 || parts.length > 3) {
      throw new LispError('if: expected (if test then else?)');
    }
    // The test is non-tail; the chosen branch is in tail position.
    if (isTruthy(evaluate(parts[0], env))) {
      return new TailCall(parts[1], env);
    }
    return parts.length === 3 ? new TailCall(parts[2], env) : NIL;
  },

  define(form, env) {
    const parts = args(form);
    const target = parts[0];

    if (target instanceof Sym) {
      if (parts.length !== 2) {
        throw new LispError('define: expected (define name value)');
      }
      const value = evaluate(parts[1], env);
      if (value instanceof Lambda && value.name === 'anonymous') {
        value.name = target.name;
      }
      env.define(target.name, value);
      return target;
    }

    if (target instanceof Pair) {
      const name = target.head;
      if (!(name instanceof Sym)) {
        throw new LispError('define: malformed function name');
      }
      const { params, rest } = parseParameters(target.tail);
      let body = parts.slice(1);
      let doc = null;
      // A leading string literal, with more body after it, is a docstring.
      if (body.length > 1 && typeof body[0] === 'string') {
        doc = body[0];
        body = body.slice(1);
      }
      if (body.length === 0) {
        throw new LispError('define: a function needs a body');
      }
      const lambda = new Lambda(params, rest, body, env);
      lambda.name = name.name;
      lambda.doc = doc;
      lambda.source = sourceLocations.get(form) ?? null;
      env.define(name.name, lambda);
      return name;
    }

    throw new LispError('define: first argument must be a symbol or a list');
  },

  lambda(form, env) {
    const parts = args(form);
    if (parts.length < 2) {
      throw new LispError('lambda: expected (lambda params body...)');
    }
    const { params, rest } = parseParameters(parts[0]);
    return new Lambda(params, rest, parts.slice(1), env);
  },

  defmacro(form, env) {
    const parts = args(form);
    if (parts.length < 3 || !(parts[0] instanceof Sym)) {
      throw new LispError('defmacro: expected (defmacro name params body...)');
    }
    const name = parts[0];
    const { params, rest } = parseParameters(parts[1]);
    const transformer = new Lambda(params, rest, parts.slice(2), env);
    transformer.name = `${name.name}:transformer`;
    env.define(name.name, new LispMacro(name.name, transformer));
    return name;
  },

  begin(form, env) {
    return evaluateBodyTail(args(form), env);
  },

  'set!'(form, env) {
    const parts = args(form);
    if (parts.length !== 2 || !(parts[0] instanceof Sym)) {
      throw new LispError('set!: expected (set! name value)');
    }
    return env.assign(parts[0].name, evaluate(parts[1], env));
  },

  let(form, env) {
    const parts = args(form);
    // Named let: (let name ((var init)…) body…). Rewritten to
    //   ((letrec ((name (lambda (var…) body…))) name) init…)
    // and bounced as a tail call, which yields the semantics for free:
    // the inits are ordinary application arguments (evaluated in the
    // OUTER scope), `name` recurs through the letrec frame without
    // leaking into the surrounding scope, and the recursive call is a
    // plain application the trampoline runs in constant stack.
    if (parts[0] instanceof Sym) {
      if (parts.length < 2) {
        throw new LispError('let: expected (let name ((var init)...) body...)');
      }
      const name = parts[0];
      const bindings = listToArray(parts[1]).map((b) => listToArray(b));
      const vars = bindings.map(([v]) => v);
      const inits = bindings.map(([, init]) => init);
      const lambdaForm = arrayToList([
        sym('lambda'),
        arrayToList(vars),
        ...parts.slice(2),
      ]);
      const letrecForm = list(sym('letrec'), list(list(name, lambdaForm)), name);
      return new TailCall(arrayToList([letrecForm, ...inits]), env);
    }
    const scope = new Environment(env);
    for (const binding of listToArray(parts[0])) {
      const [name, valueForm] = listToArray(binding);
      // Values are evaluated in the outer environment.
      scope.define(name.name, evaluate(valueForm, env));
    }
    return evaluateBodyTail(parts.slice(1), scope);
  },

  'let*'(form, env) {
    const parts = args(form);
    const scope = new Environment(env);
    for (const binding of listToArray(parts[0])) {
      const [name, valueForm] = listToArray(binding);
      // Each value sees the bindings before it.
      scope.define(name.name, evaluate(valueForm, scope));
    }
    return evaluateBodyTail(parts.slice(1), scope);
  },

  letrec(form, env) {
    const parts = args(form);
    const scope = new Environment(env);
    const bindings = listToArray(parts[0]).map((b) => listToArray(b));
    // All names are visible to all values, so functions can recur.
    for (const [name] of bindings) scope.define(name.name, NIL);
    for (const [name, valueForm] of bindings) {
      scope.assign(name.name, evaluate(valueForm, scope));
    }
    return evaluateBodyTail(parts.slice(1), scope);
  },

  cond(form, env) {
    for (const clause of args(form)) {
      const parts = listToArray(clause);
      const test = parts[0];
      const isElse = test instanceof Sym && test.name === 'else';
      if (isElse) {
        // A bare `(else)` clause tail-evaluates the symbol `else` itself
        // (unbound unless the user defined it) — documented behaviour.
        return parts.length === 1
          ? new TailCall(test, env)
          : evaluateBodyTail(parts.slice(1), env);
      }
      const value = evaluate(test, env);
      if (isTruthy(value)) {
        // A one-element clause `(x)` yields x's value — already computed
        // for the truth check, so return it directly rather than
        // re-evaluating (there is no body, so nothing is lost from tail
        // position). A clause body runs in tail position.
        return parts.length === 1
          ? value
          : evaluateBodyTail(parts.slice(1), env);
      }
    }
    return NIL;
  },

  and(form, env) {
    const parts = args(form);
    if (parts.length === 0) return true;
    // All but the last short-circuit on a falsy value; the last is tail.
    for (let i = 0; i < parts.length - 1; i += 1) {
      const value = evaluate(parts[i], env);
      if (!isTruthy(value)) return value;
    }
    return new TailCall(parts[parts.length - 1], env);
  },

  or(form, env) {
    const parts = args(form);
    if (parts.length === 0) return false;
    // All but the last short-circuit on a truthy value; the last is tail.
    for (let i = 0; i < parts.length - 1; i += 1) {
      const value = evaluate(parts[i], env);
      if (isTruthy(value)) return value;
    }
    return new TailCall(parts[parts.length - 1], env);
  },

  // (try body… (catch name handler…)? (finally cleanup…)?)
  // Clauses in that order, each optional, at least one present. Neither
  // the body, the handler, nor the finally forms are tail positions: each
  // sits inside this JS try/catch/finally, whose frame must stay live on
  // the stack while they run — so all three use the eager evaluateBody,
  // never a TailCall that would escape the frame.
  try(form, env) {
    const parts = args(form);
    const isClause = (part, name) =>
      part instanceof Pair &&
      part.head instanceof Sym &&
      part.head.name === name;

    // Peel the clauses off the end: (finally …) last, (catch …) before
    // it. Whatever remains is the body — which must not itself contain a
    // clause-shaped form (that means the clauses were duplicated or in
    // the wrong order).
    let end = parts.length;
    let finallyClause = null;
    if (end > 0 && isClause(parts[end - 1], 'finally')) {
      finallyClause = parts[end - 1];
      end -= 1;
    }
    let catchClause = null;
    if (end > 0 && isClause(parts[end - 1], 'catch')) {
      catchClause = parts[end - 1];
      end -= 1;
    }
    if (catchClause === null && finallyClause === null) {
      throw new LispError(
        'try: the last clause must be (catch name body...) or (finally body...)'
      );
    }
    const body = parts.slice(0, end);
    for (const part of body) {
      if (isClause(part, 'catch') || isClause(part, 'finally')) {
        throw new LispError(
          'try: clauses must come last, in the order (catch …) then (finally …)'
        );
      }
    }

    let varName = null;
    let catchParts = null;
    if (catchClause !== null) {
      catchParts = listToArray(catchClause.tail);
      varName = catchParts[0];
      if (!(varName instanceof Sym)) {
        throw new LispError('try: catch needs a variable name');
      }
    }

    try {
      try {
        return evaluateBody(body, env);
      } catch (error) {
        // Only LispErrors are catchable; raw JS exceptions from host
        // primitives pass through (but still trigger the finally below).
        if (catchClause === null || !(error instanceof LispError)) throw error;
        // Tag the offending form's location before the handler sees it, so
        // the condition value can carry :line / :column (B6).
        attachErrorLocation(error);
        const scope = new Environment(env);
        scope.define(varName.name, conditionValue(error));
        return evaluateBody(catchParts.slice(1), scope);
      }
    } finally {
      if (finallyClause !== null) {
        // Cleanup runs on EVERY exit: normal completion, a caught error
        // (after the handler), an error propagating out — even a raw JS
        // exception. Its value is discarded; an error raised here
        // replaces whatever was propagating (JS semantics).
        evaluateBody(listToArray(finallyClause.tail), env);
      }
    }
  },

  module(form, env) {
    const parts = args(form);
    if (parts.length < 1 || !(parts[0] instanceof Sym)) {
      throw new LispError('module: expected (module name body...)');
    }
    const name = parts[0];
    const { registry, base } = moduleRegistry(env);

    // An `(export …)` form anywhere in the body is a declaration, not
    // code; everything else is evaluated in the module's environment.
    const exports = new Set();
    const body = [];
    for (const f of parts.slice(1)) {
      if (f instanceof Pair && f.head instanceof Sym && f.head.name === 'export') {
        for (const symbol of listToArray(f.tail)) {
          if (!(symbol instanceof Sym)) {
            throw new LispError('module: exported names must be symbols');
          }
          exports.add(symbol.name);
        }
      } else {
        body.push(f);
      }
    }

    // Reloading a module reuses its environment, so closures that hold
    // it see the new definitions; clearing first drops removed ones.
    const existing = registry.get(name.name);
    const moduleEnv = existing ? existing.env : new Environment(base);
    moduleEnv.vars.clear();
    for (const f of body) {
      evaluate(f, moduleEnv);
    }
    registry.set(name.name, { name: name.name, env: moduleEnv, exports });
    return name;
  },

  import(form, env) {
    const parts = args(form);
    if (parts.length !== 1 || !(parts[0] instanceof Sym)) {
      throw new LispError('import: expected (import module-name)');
    }
    const { registry } = moduleRegistry(env);
    const module = registry.get(parts[0].name);
    if (module === undefined) {
      throw new LispError(`no such module: ${parts[0].name}`);
    }
    for (const exported of module.exports) {
      env.define(exported, module.env.lookup(exported));
    }
    return parts[0];
  },
};

/** The set of special-form names, for tooling. */
export const specialFormNames = Object.freeze(Object.keys(SPECIAL_FORMS));
