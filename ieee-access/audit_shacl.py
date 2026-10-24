"""Recompute Table 8 from retained N2 records, without rerunning benchmarks."""
import json
import re
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / 'data/results-v3/n2-shacl-bench'

def audited_summary():
    summary = json.loads((DATA / 'n2-summary.json').read_text())
    rows = json.loads((DATA / 'compare.json').read_text())['rows']
    for r in rows:
        if r.get('error'):
            continue
        engine = 'jena' if r['engine'] == 'jena-shacl' else r['engine']
        raw = json.loads((DATA / r['id'] / ('shacl-' + engine + '-' + r['file'].replace('.ttl', '.json'))).read_text())
        assert median(raw['validateSamplesMs']) == raw['validateMs'] == r['validateMs']
        assert raw['version'] == r['version']
    for entry in summary['rows']:
        selected = [r for r in rows if not r.get('error') and r['n'] == entry['n'] and r['engine'] == entry['engine'] and (r['file'] == 'data.ttl') == (entry['kind'] == 'full')]
        assert len(selected) == entry['runs']
        assert median(r['validateMs'] for r in selected) == entry['shaclValidateMsMedian']
        denominator = 'engineValidateMs' if entry['kind'] == 'full' else 'incrementalStepMs'
        assert median(r[denominator] for r in selected) == entry['proposedMsMedian']
        ratios = []
        for r in selected:
            ratio = r['validateMs'] / r[denominator]
            assert abs(ratio - r['ratio' if entry['kind'] == 'full' else 'ratioVsIncrementalStep']) < 1e-8
            ratios.append(ratio)
        assert median(ratios) == entry['ratioMedian']
    cases = json.loads((DATA / 'engine-cases.json').read_text())['cases']
    for e in summary['engine']:
        cs = [c for c in cases if c['n'] == e['n']]
        assert median(c['engine']['validateMs'] for c in cs) == e['engineFullMsMedian']
        assert median(c['engine']['validateCoreMs'] for c in cs) == e['engineCoreSubsetMsMedian']
    return summary

def render():
    d = audited_summary()
    lines = [r'\begin{table*}[t]', r'\centering\scriptsize',
        r'\caption{Separate N2 session: validation milliseconds and median per-seed time ratios. Core excludes VIEW, ACYC, and TRACE.}',
        r'\label{tab:shacl}', r'\setlength{\tabcolsep}{5pt}',
        r'\begin{tabular}{@{}rrrrrrrrr@{}}', r'\toprule',
        r'$n$ & Engine-All & Engine-Core & Jena-All & Jena/All & shacl-engine-Core & Core/Core & pySHACL-All & pySHACL/All \\',r'\midrule']
    for e in d['engine']:
        rs = {r['engine']:r for r in d['rows'] if r['n']==e['n'] and r['kind']=='full'}
        vals = [f"$10^{len(str(e['n']))-1}$",f"{e['engineFullMsMedian']:.2f}",f"{e['engineCoreSubsetMsMedian']:.2f}"]
        for engine in ['jena-shacl','shacl-engine-core','pyshacl']:
            r=rs.get(engine)
            vals.extend([f"{r['shaclValidateMsMedian']:,.2f}",f"{r['ratioMedian']:,.1f}"] if r else ['--','--'])
        lines.append(' & '.join(vals)+r' \\')
    lines.extend([r'\midrule',r'\multicolumn{9}{l}{Jena post-edit batch / seed-level typical incremental step (all rules)}\\',
        r'$n$ & \multicolumn{2}{c}{Engine step (ms)} & Jena (ms) & Jena/step & \multicolumn{4}{l}{Seed/post-edit records}\\'])
    for r in d['rows']:
        if r['kind']=='afterOneEdit' and r['engine']=='jena-shacl':
            lines.append(f"$10^{len(str(r['n']))-1}$ & "+r'\multicolumn{2}{c}{'+f"{r['proposedMsMedian']:.5f}"+'} & '+f"{r['shaclValidateMsMedian']:,.2f} & {r['ratioMedian']:,.1f} & "+r'\multicolumn{4}{l}{'+str(r['runs'])+r'}\\')
    lines.extend([r'\bottomrule',r'\end{tabular}',r'\begin{minipage}{0.98\textwidth}\footnotesize',
        r'Times are medians of per-seed medians; ratios are medians of per-record ratios, not ratios of the displayed medians. For example, $121.05/3.00$ need not equal 37.6. All uses the complete rule set; Core uses the same restricted set on both sides. One-edit ratios divide each post-edit batch time by its seed\textquotesingle s median over 20 incremental edits, not the time of that individual edit; initialization is excluded. The original session includes full-list construction. Session identity: \texttt{data/results-v3/n2-shacl-bench}; raw samples and input hashes are retained. Numerical reaggregation is supported; identical-execution reconstruction of the original session is limited. -- indicates no recorded measurement.',
        r'\end{minipage}',r'\end{table*}',''])
    return '\n'.join(lines)

def paired_sensitivity():
    cases = {c['id']: c for c in json.loads((DATA / 'engine-cases.json').read_text())['cases']}
    rows = json.loads((DATA / 'compare.json').read_text())['rows']
    grouped = {}
    for row in rows:
        match = re.fullmatch(r'data-post(\d+)\.ttl', row.get('file', ''))
        if row.get('error') or row['engine'] != 'jena-shacl' or not match:
            continue
        j = int(match.group(1))
        case = cases[row['id']]
        assert case['n'] == row['n'] and case['post'][j]['batchEqual']
        samples = case['incremental']['stepSamplesMs']
        assert len(samples) == case['incremental']['edits'] == 20
        assert median(samples) == row['incrementalStepMs']
        assert samples[j] > 0
        grouped.setdefault(row['n'], []).append(row['validateMs'] / samples[j])
    assert {n: len(v) for n, v in grouped.items()} == {1000: 9, 10000: 9, 100000: 3}
    values = [f'{median(grouped[n]):,.1f}' for n in [1000, 10000, 100000]]
    return ('As a sensitivity analysis of the retained records, replacing the seed-level denominator '
            'by the corresponding edit sample gives median Jena/step ratios of ' + ', '.join(values) +
            r' at $10^3$, $10^4$, and $10^5$ nodes, respectively (9, 9, and 3 seed/edit pairs). '
            r'The index $j$ links \texttt{data-postj.ttl}, \texttt{post[j]}, and \texttt{stepSamplesMs[j]} '
            r'in the export loop. Each incremental edit has one timed observation, whereas Jena uses '
            r'the recorded within-input repetition median; this sensitivity analysis does not provide '
            r'additional independent trials or stronger statistical evidence of superiority.' + '\n')

if __name__ == '__main__':
    expected = render()
    assert (ROOT / 'tab-shacl.tex').read_text(encoding='utf-8') == expected, 'Table differs from retained data'
    assert (ROOT / 'n2-paired-sensitivity.tex').read_text(encoding='utf-8') == paired_sensitivity()
    print('N2 aggregation, denominators, and rendered table verified')
