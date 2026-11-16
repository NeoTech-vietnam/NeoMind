import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import create_fixture


class SyntheticFixtureTests(unittest.TestCase):
    def test_create_valid_fixture_and_refuse_existing_directory(self):
        with tempfile.TemporaryDirectory(prefix='neomind-broker-fixture-') as root:
            dest = Path(root) / 'fixture'
            create_fixture.create(dest)
            env = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
            env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(dest), *args], env=env, text=True)
            self.assertEqual(git('ls-tree', '-r', '--name-only', 'HEAD').splitlines(), sorted(create_fixture.FILES))
            for name, value in create_fixture.FILES.items():
                self.assertEqual(git('show', f'HEAD:{name}'), value)
            self.assertEqual(git('status', '--porcelain'), '')
            with self.assertRaises(FileExistsError):
                create_fixture.create(dest)
            self.assertEqual(git('status', '--porcelain'), '')


if __name__ == '__main__':
    unittest.main()
