"""Render existing input/output records for the worked example; no validator execution."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / 'data/results-v4'


def render():
    example = json.loads((DATA / 'r5-example/worked-example.json').read_text(encoding='utf-8'))
    source = json.loads((DATA / 'r8/n17-worked-example-sysml.json').read_text(encoding='utf-8'))
    keyword = next(r for r in source['rows'] if r['mode'] == 'keyword')
    assert keyword['isomorphicToTable3'] and len(keyword['nodes']) == 8 and len(keyword['edges']) == 9
    clean = example['stages'][2]['detail']['violations']
    assert clean == keyword['engineViolations'] == [] and example['cleanViolations'] == 0
    domain = next(r for r in example['defectViolations'] if r['defect'].startswith('attribute domain'))
    assert domain['edit'] == 'set C2.criticality = "X"'
    inc = example['incremental']
    assert inc['change'] == 'delete e5 (satisfy C1 -> R1)' and inc['matchesBatch']
    assert inc['scopeSize'] == inc['graphSize'] == 8 and inc['radius'] == 2
    assert [v['ruleId'] for v in inc['violationsAfter']] == ['MULT:Requirement|satisfy|in', 'TRACE:FUN2REQ']
    def listing(value):
        return (r'\begin{lstlisting}[basicstyle=\ttfamily\fontsize{8}{9}\selectfont,columns=fullflexible,keepspaces=true,breaklines=true,breakatwhitespace=true,postbreak=\mbox{\ensuremath{\hookrightarrow}\space},frame=single,aboveskip=4pt,belowskip=6pt,xleftmargin=3pt,xrightmargin=3pt]' + '\n'
                + json.dumps(value, indent=2, ensure_ascii=True) + '\n' + r'\end{lstlisting}' + '\n')
    return (r'''\begin{table*}[t]
\centering
\caption{Input changes and recorded validator outputs for the worked example. Each change starts independently from the clean keyword-mode graph; the JSON blocks are excerpts of retained records, not a new API schema. Arrows mark display-only line wraps.}
\label{tab:example-io}
\begin{minipage}[t]{0.48\textwidth}
\vspace{0pt}\small
\textbf{(a) Normal input and output}\par
Input: source in Table~\ref{tab:exmodel} plus the aerospace catalog. S1 yields 8 nodes and 9 relations; S2 derives 41 rules (39 local, 2 global). Full validation detects zero violations under this catalog; the recorded violation list is empty (\texttt{[]}):
''' + listing(clean) + r'''
\textbf{(b) Attribute-error input and output}\par
Starting from the clean graph, set \texttt{C2.criticality} to \texttt{"X"}. The recorded \texttt{rows} list is:
''' + listing(domain['rows']) + r'''
\end{minipage}\hfill
\begin{minipage}[t]{0.49\textwidth}
\vspace{0pt}\small
\textbf{(c) Incremental input and output}\par
Starting again from the clean graph, delete \texttt{e5}, the \texttt{satisfy} edge from C1 to R1. The retained \texttt{incremental} record is:
''' + listing(inc) + r'''
\end{minipage}
\end{table*}
''')


if __name__ == '__main__':
    assert (ROOT / 'example-io.tex').read_text(encoding='utf-8') == render()
    print('Worked-example JSON excerpts agree with retained records; no experiment rerun')
