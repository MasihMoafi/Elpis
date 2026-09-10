"""Guard public figures against incorrect arithmetic and cohort mixing."""
import copy
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('refresh-public-evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)

class PublicEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(evidence.SOURCE.read_text())

    def test_recorded_arithmetic(self):
        evidence.validate(self.data)

    def test_rejects_wrong_optimizer_total(self):
        data = copy.deepcopy(self.data)
        data['batches'][0]['pairs'][0]['cost']['optimizer'] += .001
        with self.assertRaises(ValueError):
            evidence.validate(data)

    def test_rejects_duplicate_cohort(self):
        with self.assertRaises(AssertionError):
            evidence.aggregate(self.data, ['e1-low', 'e1-low'], 'invalid')

    def test_rejects_mixed_binary(self):
        data = copy.deepcopy(self.data)
        for batch in data['batches']:
            if 'e2-32c-low' in batch['batch']:
                batch['binaryHash'] = 'different-build'
        with self.assertRaises(AssertionError):
            evidence.aggregate(data, ['e2-32b-low', 'e2-32c-low'], 'invalid')

if __name__ == '__main__':
    unittest.main()
