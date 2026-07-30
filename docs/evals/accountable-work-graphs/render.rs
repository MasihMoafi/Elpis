use std::env;
use std::fs;
use std::path::Path;

fn main() {
    let mut args = env::args().skip(1);
    let input = args.next().expect("usage: render RESULTS.csv OUTPUT.svg");
    let output = args.next().expect("usage: render RESULTS.csv OUTPUT.svg");
    assert!(args.next().is_none(), "usage: render RESULTS.csv OUTPUT.svg");

    let csv = fs::read_to_string(&input).expect("read results");
    let rows = csv
        .lines()
        .skip(1)
        .map(|line| {
            let fields = line.split(',').collect::<Vec<_>>();
            assert_eq!(fields.len(), 5, "unexpected results row: {line}");
            let passed = fields[2..]
                .iter()
                .map(|value| value.parse::<u8>().expect("result must be 0 or 1"))
                .sum::<u8>();
            assert!(passed <= 3, "result must be 0 or 1");
            (fields[0].to_string(), fields[1].to_string(), passed)
        })
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 2, "expected before and after rows");

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="760" height="310" viewBox="0 0 760 310" role="img" aria-labelledby="title desc">
<title id="title">Accountable work graph negative checks</title>
<desc id="desc">Before the implementation zero of three negative checks passed. After the implementation three of three passed.</desc>
<rect width="760" height="310" fill="#0b0f14"/>
<text x="40" y="42" fill="#f5f7fa" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" font-weight="700">Accountable work graphs</text>
<text x="40" y="70" fill="#9aa4b2" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="13">Negative checks passed · source: results.csv</text>
<line x1="180" y1="252" x2="700" y2="252" stroke="#384250"/>
<line x1="180" y1="100" x2="180" y2="252" stroke="#384250"/>
<text x="163" y="257" fill="#9aa4b2" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">0</text>
<text x="331" y="257" fill="#9aa4b2" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">1</text>
<text x="504" y="257" fill="#9aa4b2" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">2</text>
<text x="690" y="257" fill="#9aa4b2" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">3</text>
<text x="40" y="139" fill="#c8d0da" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14">before {before_sha}</text>
<rect x="180" y="116" width="{before_width}" height="34" rx="4" fill="#ef4444"/>
<text x="{before_label_x}" y="139" fill="#f5f7fa" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" font-weight="700">{before_passed}/3</text>
<text x="40" y="207" fill="#c8d0da" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14">after  {after_sha}</text>
<rect x="180" y="184" width="{after_width}" height="34" rx="4" fill="#22d3ee"/>
<text x="{after_label_x}" y="207" fill="#061319" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="14" font-weight="700">{after_passed}/3</text>
<text x="40" y="292" fill="#748091" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">omitted edits · missing verifier · concurrent writers in one environment</text>
</svg>
"##,
        before_sha = rows[0].0,
        before_passed = rows[0].2,
        before_width = u16::from(rows[0].2) * 173,
        before_label_x = 190 + u16::from(rows[0].2) * 173,
        after_sha = rows[1].0,
        after_passed = rows[1].2,
        after_width = u16::from(rows[1].2) * 173,
        after_label_x = 650,
    );

    if let Some(parent) = Path::new(&output).parent() {
        fs::create_dir_all(parent).expect("create output directory");
    }
    fs::write(output, svg).expect("write chart");
}
