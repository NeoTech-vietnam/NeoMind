import json
import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import quota
from runtime_paths import REPO_ROOT, require_data_root, verify_live_budget

DATA = require_data_root()


class RuntimePathsTests(unittest.TestCase):
    def test_cap_extension_requires_matching_explicit_anchor_and_preserves_history(self):
        with tempfile.TemporaryDirectory(dir=DATA / 'tmp') as directory:
            root = Path(directory); db = root / 'fixture.sqlite'
            quota.initialize(str(db), 40)
            for index in range(4):
                workflow = f'original-{index}'
                quota.start_workflow(str(db), workflow, 5)
                quota.bind(str(db), f'ses_{index}', workflow, 5)
                quota.reserve(str(db), f'ses_{index}', f'reservation-{index}')
            stat = db.stat()
            anchor = {'schemaVersion': 1, 'database': str(db.resolve()), 'device': stat.st_dev, 'inode': stat.st_ino,
                      'minimumWorkflows': 4, 'minimumReservations': 4, 'requiredReservationIds': [f'reservation-{index}' for index in range(4)]}
            anchor_path = root / 'live-budget.anchor.json'
            anchor_path.write_text(json.dumps(anchor))
            verify_live_budget(root, str(db))
            with self.assertRaises(ValueError): quota.start_workflow(str(db), 'extra', 5)
            with closing(quota.connect(str(db))) as conn:
                conn.execute('UPDATE limits SET workflow_cap=5 WHERE id=1')
            with self.assertRaises(ValueError): verify_live_budget(root, str(db))
            anchor['workflowCap'] = 5
            anchor_path.write_text(json.dumps(anchor))
            verify_live_budget(root, str(db))
            quota.start_workflow(str(db), 'extra', 5)
            quota.bind(str(db), 'ses_extra', 'extra', 5)
            for index in range(5): quota.reserve(str(db), 'ses_extra', f'new-{index}')
            with self.assertRaises(ValueError): quota.reserve(str(db), 'ses_extra', 'sixth')
            with self.assertRaises(ValueError): quota.start_workflow(str(db), 'another', 5)
            anchor['workflowCap'] = 7
            anchor_path.write_text(json.dumps(anchor))
            with self.assertRaises(ValueError): verify_live_budget(root, str(db))
            with closing(quota.connect(str(db))) as conn:
                conn.execute('UPDATE limits SET workflow_cap=7 WHERE id=1')
            verify_live_budget(root, str(db))
            quota.start_workflow(str(db), 'paid-positive', 5)
            quota.start_workflow(str(db), 'paid-control', 5)
            with self.assertRaises(ValueError): quota.start_workflow(str(db), 'eighth', 5)
            anchor['workflowCap'] = 10
            anchor_path.write_text(json.dumps(anchor))
            with self.assertRaises(ValueError): verify_live_budget(root, str(db))
            with closing(quota.connect(str(db))) as conn:
                conn.execute('UPDATE limits SET workflow_cap=10 WHERE id=1')
            verify_live_budget(root, str(db))
            for index in range(3):
                quota.start_workflow(str(db), f'luna-{index}', 5)
                quota.bind(str(db), f'ses_luna_{index}', f'luna-{index}', 5)
            for index in range(5): quota.reserve(str(db), 'ses_luna_0', f'luna-reservation-{index}')
            with self.assertRaises(ValueError): quota.reserve(str(db), 'ses_luna_0', 'luna-sixth')
            with self.assertRaises(ValueError): quota.start_workflow(str(db), 'eleventh', 5)
            for bad in (True, '5', 6, 8, 11):
                anchor['workflowCap'] = bad
                anchor_path.write_text(json.dumps(anchor))
                with self.assertRaises(ValueError): verify_live_budget(root, str(db))

    def test_reject_missing_relative_checkout_ancestor_and_symlink_escape(self):
        with self.assertRaises(ValueError):
            require_data_root('')
        with self.assertRaises(ValueError):
            require_data_root('relative')
        with self.assertRaises(FileNotFoundError):
            require_data_root(str(DATA / 'does-not-exist'))
        for path in (REPO_ROOT, REPO_ROOT.parent):
            with self.assertRaises(ValueError):
                require_data_root(str(path))
        with tempfile.TemporaryDirectory(dir=DATA / 'tmp') as directory:
            alias = Path(directory) / 'repo-link'
            alias.symlink_to(REPO_ROOT, target_is_directory=True)
            with self.assertRaises(ValueError):
                require_data_root(str(alias))
            safe = Path(directory) / 'safe'
            safe.mkdir()
            alias.unlink()
            alias.symlink_to(safe, target_is_directory=True)
            self.assertEqual(require_data_root(str(alias)), safe.resolve())
            (safe / 'runs').symlink_to(REPO_ROOT, target_is_directory=True)
            with self.assertRaises(ValueError):
                require_data_root(str(safe))

    def test_owner_anchor_checks_identity_counts_and_original_reservation(self):
        with tempfile.TemporaryDirectory(dir=DATA / 'tmp') as directory:
            root = Path(directory)
            db = root / 'fixture.sqlite'
            quota.initialize(str(db), 40)
            quota.start_workflow(str(db), 'original', 10)
            quota.bind(str(db), 'ses_original', 'original', 10)
            quota.reserve(str(db), 'ses_original', 'fixture-reservation')
            anchor_path = root / 'live-budget.anchor.json'
            with self.assertRaises(FileNotFoundError):
                verify_live_budget(root, str(db))
            stat = db.stat()
            anchor = {'schemaVersion': 1, 'database': str(db.resolve()), 'device': stat.st_dev,
                      'inode': stat.st_ino, 'minimumWorkflows': 1, 'minimumReservations': 1,
                      'requiredReservationIds': ['fixture-reservation']}
            anchor_path.write_text(json.dumps(anchor))
            self.assertEqual(verify_live_budget(root, str(db)), db.resolve())
            other = root / 'other.sqlite'
            quota.initialize(str(other), 40)
            with self.assertRaises(ValueError):
                verify_live_budget(root, str(other))
            renamed = root / 'renamed.sqlite'
            db.rename(renamed)
            with self.assertRaises(FileNotFoundError):
                verify_live_budget(root, str(db))
            with self.assertRaises(ValueError):
                verify_live_budget(root, str(renamed))
            renamed.rename(db)
            db.rename(renamed)
            other.rename(db)
            with self.assertRaises(ValueError):
                verify_live_budget(root, str(db))
            db.rename(other)
            renamed.rename(db)
            with closing(quota.connect(str(db))) as conn:
                conn.execute('DELETE FROM reservations')
            with self.assertRaises(ValueError):
                verify_live_budget(root, str(db))
            quota.reserve(str(db), 'ses_original', 'different-reservation')
            with self.assertRaises(ValueError):
                verify_live_budget(root, str(db))
            anchor['requiredReservationIds'] = ['different-reservation']
            anchor['minimumWorkflows'] = 2
            anchor_path.write_text(json.dumps(anchor))
            with self.assertRaises(ValueError):
                verify_live_budget(root, str(db))
            anchor['minimumWorkflows'] = 1
            anchor_path.write_text(json.dumps(anchor))
            with closing(quota.connect(str(db))) as conn:
                conn.execute('UPDATE limits SET cap=39')
            with self.assertRaises(ValueError):
                verify_live_budget(root, str(db))


if __name__ == '__main__':
    unittest.main(verbosity=2)
