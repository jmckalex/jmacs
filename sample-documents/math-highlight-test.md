# Markdown + LaTeX math — highlighting & preview showcase

A manual-render fixture for Markdown's embedded-math support: every region
below should be **syntax-highlighted** in the source (the LaTeX palette —
commands, braces, sub/superscripts) and, with `C-c C-p` (`markdown-preview`),
typeset by MathJax. It mixes the four delimiter pairs (`$…$`, `$$…$$`,
`\(…\)`, `\[…\]`) with `\begin{…}` environments, and ends with cases that must
stay **literal** (math inside code, escaped dollars).

---

## Quantum mechanics

The state of a system evolves by the time-dependent Schrödinger equation,

$$
i\hbar \frac{\partial}{\partial t}\,\lvert \Psi(t) \rangle = \hat{H}\,\lvert \Psi(t) \rangle ,
$$

which in the position representation, for a particle of mass $m$ in a potential
$V(\mathbf{r}, t)$, reads

$$
i\hbar \frac{\partial \psi(\mathbf{r}, t)}{\partial t}
  = \left[ -\frac{\hbar^2}{2m}\nabla^2 + V(\mathbf{r}, t) \right] \psi(\mathbf{r}, t).
$$

The canonical commutator is \([\hat{x}, \hat{p}] = i\hbar\), from which the
Heisenberg uncertainty relation $\Delta x\,\Delta p \ge \tfrac{\hbar}{2}$
follows.

### Harmonic oscillator (ladder operators)

\begin{align}
\hat{H} &= \hbar\omega\left(\hat{a}^{\dagger}\hat{a} + \tfrac{1}{2}\right) \\
[\hat{a}, \hat{a}^{\dagger}] &= 1 \\
\hat{a}\,\lvert n \rangle &= \sqrt{n}\,\lvert n-1 \rangle, \qquad
\hat{a}^{\dagger}\,\lvert n \rangle = \sqrt{n+1}\,\lvert n+1 \rangle
\end{align}

### Relativistic wave equation

Dirac's equation couples spinor components through the gamma matrices:

\[
\left( i\gamma^{\mu}\partial_{\mu} - m \right)\psi = 0 .
\]

### Spin-½ and the Pauli matrices

$$
\sigma_x = \begin{pmatrix} 0 & 1 \\ 1 & 0 \end{pmatrix}, \quad
\sigma_y = \begin{pmatrix} 0 & -i \\ i & 0 \end{pmatrix}, \quad
\sigma_z = \begin{pmatrix} 1 & 0 \\ 0 & -1 \end{pmatrix}
$$

An observable's expectation value is
$\langle \hat{A} \rangle = \langle \psi \lvert \hat{A} \rvert \psi \rangle$, and
a mixed state is described by the density operator
$\hat{\rho} = \sum_i p_i\,\lvert \psi_i \rangle\langle \psi_i \rvert$ with
$\operatorname{Tr}\hat{\rho} = 1$.

### Feynman's path integral

\[
\langle x_f \lvert\, e^{-i\hat{H}T/\hbar} \,\rvert x_i \rangle
  = \int \mathcal{D}[x(t)]\; \exp\!\left( \frac{i}{\hbar}\, S[x(t)] \right),
\qquad S[x] = \int_0^T \! L(x, \dot{x})\,dt .
\]

---

## General relativity

Spacetime curvature is sourced by energy and momentum through the Einstein
field equations,

$$
G_{\mu\nu} + \Lambda g_{\mu\nu} = \frac{8\pi G}{c^4}\, T_{\mu\nu},
\qquad
G_{\mu\nu} = R_{\mu\nu} - \tfrac{1}{2} R\, g_{\mu\nu} .
$$

The Schwarzschild solution for a non-rotating mass $M$ has line element

\[
ds^2 = -\left( 1 - \frac{2GM}{c^2 r} \right) c^2\,dt^2
       + \left( 1 - \frac{2GM}{c^2 r} \right)^{-1} dr^2
       + r^2\,d\Omega^2 ,
\qquad d\Omega^2 = d\theta^2 + \sin^2\!\theta\,d\varphi^2 .
\]

Free fall follows geodesics, fixed by the metric connection:

\begin{align}
\frac{d^2 x^{\mu}}{d\tau^2}
  + \Gamma^{\mu}_{\alpha\beta}\,\frac{dx^{\alpha}}{d\tau}\frac{dx^{\beta}}{d\tau} &= 0, \\
\Gamma^{\mu}_{\alpha\beta}
  &= \tfrac{1}{2}\, g^{\mu\nu}\!\left(
       \partial_{\alpha} g_{\nu\beta}
     + \partial_{\beta} g_{\nu\alpha}
     - \partial_{\nu} g_{\alpha\beta} \right).
\end{align}

Curvature itself is the Riemann tensor,

$$
R^{\rho}{}_{\sigma\mu\nu}
  = \partial_{\mu}\Gamma^{\rho}_{\nu\sigma}
  - \partial_{\nu}\Gamma^{\rho}_{\mu\sigma}
  + \Gamma^{\rho}_{\mu\lambda}\Gamma^{\lambda}_{\nu\sigma}
  - \Gamma^{\rho}_{\nu\lambda}\Gamma^{\lambda}_{\mu\sigma} .
$$

For a homogeneous, isotropic universe with scale factor $a(t)$, the Friedmann
equations govern the expansion:

\begin{align}
\left( \frac{\dot{a}}{a} \right)^2
  &= \frac{8\pi G}{3}\,\rho - \frac{k c^2}{a^2} + \frac{\Lambda c^2}{3}, \\
\frac{\ddot{a}}{a}
  &= -\frac{4\pi G}{3}\!\left( \rho + \frac{3p}{c^2} \right) + \frac{\Lambda c^2}{3}.
\end{align}

---

## Should stay literal (not math)

Inline code keeps its dollars: to write inline math you wrap it in `$…$`, and
`$E = mc^2$` here is shown verbatim, not typeset. A fenced block does the same:

```
The Lagrangian density $\mathcal{L} = -\tfrac14 F_{\mu\nu}F^{\mu\nu}$ is text here.
\begin{align} a &= b \end{align}  % also literal inside a code fence
```

And an escaped dollar is just currency: the textbook costs \$45, on sale for
\$30 — no math there.

---

## Mixed prose

A short paragraph weaving **bold** text, *strong* emphasis, a
[reference](https://en.wikipedia.org/wiki/Einstein_field_equations), and inline
math: the reduced Planck constant $\hbar = h/2\pi$, Gauss's law
$\nabla \cdot \mathbf{E} = \rho/\varepsilon_0$, and the mass–energy relation
$E^2 = (pc)^2 + (mc^2)^2$ — all in one breath.
