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
