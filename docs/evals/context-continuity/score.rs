use std::collections::BTreeMap;
use std::env;
use std::fs;

fn rows(path: &str) -> Vec<Vec<String>> {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("read {}: {}", path, error))
        .lines()
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.split('\t').map(str::to_owned).collect())
        .collect()
}

fn main() {
    let mut args = env::args().skip(1);
    let cases_path = args
        .next()
        .expect("usage: score CASES.tsv RESULTS.tsv|--self-test");
    let results_path = args
        .next()
        .expect("usage: score CASES.tsv RESULTS.tsv|--self-test");
    assert!(
        args.next().is_none(),
        "usage: score CASES.tsv RESULTS.tsv|--self-test"
    );

    let cases = rows(&cases_path);
    let results = if results_path == "--self-test" {
        cases
            .iter()
            .map(|row| (row[0].clone(), row[3].clone()))
            .collect::<BTreeMap<_, _>>()
    } else {
        rows(&results_path)
            .into_iter()
            .map(|row| {
                assert_eq!(row.len(), 2, "results rows must be: id<TAB>answer");
                (row[0].clone(), row[1].trim().to_string())
            })
            .collect::<BTreeMap<_, _>>()
    };
    assert_eq!(cases.len(), 30, "the protocol requires exactly 30 cases");
    assert_eq!(results.len(), 30, "results must contain exactly 30 cases");

    let mut groups = BTreeMap::<String, (u8, u8)>::new();
    for row in cases {
        assert_eq!(row.len(), 4, "case rows must have four columns");
        let answer = results
            .get(&row[0])
            .unwrap_or_else(|| panic!("missing result for {}", row[0]));
        let score = groups.entry(row[1].clone()).or_default();
        score.1 += 1;
        if answer == &row[3] {
            score.0 += 1;
        }
    }

    println!("group,passed,total");
    for (group, (passed, total)) in groups {
        println!("{group},{passed},{total}");
    }
}
