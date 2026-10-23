import type {ReactNode} from 'react';
import katex from 'katex';

export const MathText = ({tex}: {tex: string}) => (
  <span dangerouslySetInnerHTML={{__html: katex.renderToString(tex, {throwOnError: true})}}/>
);

export const TYPE_APPLICATION = {
  before: String.raw`\displaystyle\frac{\Delta;\Gamma\vdash e:\forall\alpha.\tau}{\Delta;\Gamma\vdash e[\sigma]:\tau[\sigma/\alpha]}\;\text{\small T-TApp}`,
  after: String.raw`\displaystyle\frac{\Delta;\Gamma\vdash e:\forall\alpha.\tau\qquad\color{#246c44}{\Delta\vdash\sigma\;\mathsf{type}}}{\Delta;\Gamma\vdash e[\sigma]:\tau[\sigma/\alpha]}\;\text{\small T-TApp}`,
};

export const Paper = ({children, page}: {children: ReactNode; page: number}) => (
  <div className="paper-sheet">
    <div className="paper-running-head"><span>Polymorphism and Type Safety in a Core Calculus</span><span>{page}</span></div>
    {children}
  </div>
);

export const StaticSemantics = () => <>
  <h2 className="paper-section">3 &nbsp; Static Semantics</h2>
  <p className="paper-paragraph">
    Our core language extends the typed λ-calculus with explicit type abstraction and
    application. A type context <MathText tex="\Delta"/> records bound type variables,
    while <MathText tex="\Gamma"/> assigns types to term variables. The syntax is given by
  </p>
  <div className="paper-grammar"><MathText tex={String.raw`\begin{aligned}
    \tau,\sigma &::= \alpha \mid \tau\to\sigma \mid \forall\alpha.\tau \\
    e &::= x \mid \lambda x{:}\tau.e \mid e_1\,e_2 \mid \Lambda\alpha.e \mid e[\tau]
  \end{aligned}`}/><span className="equation-number">(3)</span></div>
  <p className="paper-paragraph">
    The judgment <MathText tex="\Delta;\Gamma\vdash e:\tau"/> is defined by the rules below.
    All contexts are well formed; bound variables are chosen fresh, and substitution avoids capture.
  </p>
  <div className="paper-rule-pair">
    <MathText tex={String.raw`\displaystyle\frac{\Delta;\Gamma,x{:}\tau_1\vdash e:\tau_2}{\Delta;\Gamma\vdash\lambda x{:}\tau_1.e:\tau_1\to\tau_2}\;\text{\small T-Abs}`}/>
    <MathText tex={String.raw`\displaystyle\frac{\Delta,\alpha;\Gamma\vdash e:\tau\quad\alpha\notin\mathrm{FTV}(\Gamma)}{\Delta;\Gamma\vdash\Lambda\alpha.e:\forall\alpha.\tau}\;\text{\small T-TAbs}`}/>
  </div>
</>;

export const StaticSemanticsAfter = () => <>
  <div className="paper-caption">Figure 2. &nbsp; Selected typing rules for the polymorphic core.</div>
  <p className="paper-paragraph">
    Type application instantiates a universally quantified type with a well-formed
    argument. This premise ensures that the result remains meaningful in the ambient
    type context, including when polymorphic values are instantiated under a binder.
  </p>
  <h3 className="paper-subsection">3.1 &nbsp; Structural properties</h3>
  <p className="paper-paragraph"><strong>Lemma 3.1 (Weakening).</strong> Extending a well-formed
    context with fresh bindings preserves every typing derivation. The proof proceeds
    by induction on the final typing rule.</p>
</>;

export const Preservation = () => <>
  <h2 className="paper-section">4 &nbsp; Type Safety</h2>
  <p className="paper-paragraph">
    Evaluation is call-by-value. Term and type application reduce by the following
    rules, closed under evaluation contexts. We write <MathText tex="e\longrightarrow e'"/>
    {' '}for a single reduction step and treat terms up to α-equivalence.
  </p>
  <div className="paper-reduction"><MathText tex={String.raw`(\lambda x{:}\tau.e)\,v\longrightarrow e[v/x]\qquad(\Lambda\alpha.e)[\sigma]\longrightarrow e[\sigma/\alpha]`}/><span className="equation-number">(5)</span></div>
  <p className="paper-paragraph theorem"><strong>Lemma 4.1 (Type substitution).</strong>{' '}
    If <MathText tex="\Delta,\alpha;\Gamma\vdash e:\tau"/> and <MathText tex="\Delta\vdash\sigma\;\mathsf{type}"/>, then
  </p>
  <div className="paper-substitution"><MathText tex={String.raw`\Delta;\Gamma[\sigma/\alpha]\vdash e[\sigma/\alpha]:\tau[\sigma/\alpha].`}/></div>
  <p className="paper-paragraph theorem"><strong>Theorem 4.2 (Preservation).</strong>{' '}
    If <MathText tex="\varnothing;\varnothing\vdash e:\tau"/> and <MathText tex="e\longrightarrow e'"/>,
    then <MathText tex="\varnothing;\varnothing\vdash e':\tau"/>.
  </p>
  <p className="paper-paragraph proof-intro"><em>Proof.</em> By induction on typing.
    Congruence cases use the induction hypothesis. For the type-application redex{' '}
    <MathText tex="e=(\Lambda\alpha.e_0)[\sigma]"/>, we have:</p>
</>;

export const ProofText = ({version}: {version: 'before' | 'after' | 'revised'}) => {
  if (version === 'after') return <>
    The type-application case follows immediately by inversion of the typing derivation.
  </>;
  return <>
    {version === 'before' ? 'By inversion of T-TApp and T-TAbs, we obtain' : 'Inversion gives'}{' '}
    <MathText tex="\alpha;\varnothing\vdash e_0:\tau_0"/>.
    {' '}{version === 'before' ? 'Applying the type substitution lemma yields' : 'By Lemma 4.1,'}{' '}
    <MathText tex="\varnothing;\varnothing\vdash e_0[\sigma/\alpha]:\tau_0[\sigma/\alpha]"/>, as required.
    <span className="qed">□</span>
  </>;
};

export const PreservationAfter = () => <>
  <p className="paper-paragraph"><strong>Corollary 4.3 (Safety).</strong> A closed, well-typed
    term cannot reduce to a stuck state. The result follows by combining preservation
    with progress and induction on the length of the reduction sequence.</p>
  <h3 className="paper-subsection">4.1 &nbsp; Discussion</h3>
  <p className="paper-paragraph">The separation between term and type substitution makes
    the polymorphic cases explicit, while leaving the standard λ-calculus argument unchanged.</p>
</>;

export const OpeningPdf = () => (
  <div className="opening-pdf">
    <Paper page={5}>
      <h2 className="paper-section">4 &nbsp; Type Safety</h2>
      <p className="paper-paragraph theorem"><strong>Lemma 4.1 (Type substitution).</strong>{' '}
        If <MathText tex="\Delta,\alpha;\Gamma\vdash e:\tau"/> and <MathText tex="\Delta\vdash\sigma\;\mathsf{type}"/>, then
      </p>
      <div className="paper-substitution"><MathText tex={String.raw`\Delta;\Gamma[\sigma/\alpha]\vdash e[\sigma/\alpha]:\tau[\sigma/\alpha].`}/></div>
      <p className="paper-paragraph theorem"><strong>Theorem 4.2 (Preservation).</strong>{' '}
        If <MathText tex="\varnothing;\varnothing\vdash e:\tau"/> and <MathText tex="e\longrightarrow e'"/>,
        then <MathText tex="\varnothing;\varnothing\vdash e':\tau"/>.
      </p>
      <div className="selected-proof">
        <p className="paper-paragraph"><em>Proof.</em> By induction on typing. For the type-application redex{' '}
          <MathText tex="e=(\Lambda\alpha.e_0)[\sigma]"/>, inversion gives{' '}
          <MathText tex="\alpha;\varnothing\vdash e_0:\tau_0"/>. By Lemma 4.1,{' '}
          <MathText tex="\varnothing;\varnothing\vdash e_0[\sigma/\alpha]:\tau_0[\sigma/\alpha]"/>, as required.
          <span className="qed">□</span>
        </p>
      </div>
    </Paper>
  </div>
);
