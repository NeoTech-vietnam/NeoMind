"""Plugins named in kit.json `plugins`: a project-relative .py file with register(api)."""

import sys
import unittest

from . import project
from .project import ProjectCase, entry, kb, run_cli_raw

PLUGIN = '''
def register(api):
    api.add_types('NOTE', 'ISSUE')
    api.add_types('NOTE')

    def args(p):
        p.add_argument('word')
        p.add_argument('--upper', action='store_true')

    def run(kb, root, a):
        hits = [r['id'] for r in kb.search(root, a.word)['results']]
        return {'word': a.word.upper() if a.upper else a.word, 'hits': hits, 'project': root.name[:4]}

    api.command('wordhits', 'ids that match a word', args, run)
    api.on('post_bash', lambda kb, root, command, output: None)
'''

SECOND = '''
def register(api):
    api.command('wordhits', 'the same name again', lambda p: None, lambda kb, root, a: {})
'''

FAILING = '''
def register(api):
    def run(kb, root, a):
        raise kb.KBError('plugin says no')
    api.command('refuse', 'always refuses', lambda p: None, run)
'''

SHADOW = '''
def register(api):
    api.command('get', 'a command with a built-in name', lambda p: p.add_argument('id'),
                lambda kb, root, a: {'shadow': True})
'''


class PluginCase(ProjectCase):
    GROUPS = ('tracker-decisions',)

    def setUp(self):
        super().setUp()
        path = list(sys.path)  # A plugin's folder is put on sys.path when it loads.
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), path))

    def use(self, **plugins):
        """Write each plugin as tools/<name>.py and list them, in order, in kit.json."""
        for name, text in plugins.items():
            self.write(f'tools/{name}.py', text)
        self.p.write_kit(plugins=[f'tools/{name}.py' for name in plugins])


class PluginCommandTests(PluginCase):
    def test_a_plugin_adds_a_command(self):
        self.use(extra=PLUGIN)
        code, result = self.cli('wordhits', 'routing')
        self.assertEqual((code, result), (0, {'word': 'routing', 'hits': ['D4'], 'project': self.root.name[:4]}))
        code, result = self.cli('wordhits', 'routing', '--upper')
        self.assertEqual(result['word'], 'ROUTING')

    def test_the_command_is_listed_in_help_with_its_text(self):
        self.use(extra=PLUGIN)
        done = run_cli_raw(self.root, '--help')
        self.assertEqual(done.returncode, 0)
        self.assertIn('wordhits', done.stdout)
        self.assertIn('ids that match a word', done.stdout)

    def test_without_the_plugin_the_command_does_not_exist(self):
        done = run_cli_raw(self.root, 'wordhits', 'routing')
        self.assertEqual(done.returncode, 2)
        self.assertIn('invalid choice', done.stderr)

    def test_a_plugin_that_raises_kb_error_gives_the_normal_json_error(self):
        self.use(refuse=FAILING)
        code, result = self.cli('refuse')
        self.assertEqual((code, result), (2, {'ok': False, 'error': 'plugin says no', 'command': 'refuse'}))

    def test_a_command_named_like_a_built_in_is_reported_as_json(self):
        self.use(shadow=SHADOW)
        code, result = self.cli('get', 'D1')
        self.assertEqual(code, 2)
        self.assertFalse(result['ok'])


class PluginTypeTests(PluginCase):
    def entry(self, **extra):
        return entry('ops-exceptions', type='NOTE', **extra)

    def test_a_plugin_adds_a_record_type(self):
        with self.assertRaisesRegex(kb.KBError, 'Invalid type for ops-exceptions'):
            kb.add_group(self.root, self.entry(), 'fixture add')
        self.use(extra=PLUGIN)
        kb.add_group(self.root, self.entry(), 'fixture add')
        self.assertEqual(kb.get(self.root, 'OPS-EXC-1')['type'], 'NOTE')
        self.assertEqual([r['id'] for r in kb.search(self.root, 'damaged', kind='NOTE')['results']], ['OPS-EXC-2'])
        self.assertEqual(kb.types(self.root)[-2:], ('NOTE', 'ISSUE'))

    def test_a_plugin_type_can_be_hidden_like_any_other(self):
        self.use(extra=PLUGIN)
        kb.add_group(self.root, self.entry(), 'fixture add')
        self.p.write_kit(kb={'hidden_types': ['NOTE']})
        result = kb.search(self.root, 'damaged')
        self.assertEqual((result['results'], result['hidden_rows']), ([], 1))

    def test_the_types_of_kit_json_and_of_plugins_both_count(self):
        self.use(extra=PLUGIN)
        self.p.write_kit(kb={'extra_types': ['FIELD']})
        self.assertEqual(kb.types(self.root)[-3:], ('FIELD', 'NOTE', 'ISSUE'))


class PluginLoadingTests(PluginCase):
    def test_register_gets_an_api_that_collects_commands_types_and_hooks(self):
        self.use(extra=PLUGIN)
        api = kb.plugins(self.root)
        self.assertEqual(list(api.commands), ['wordhits'])
        self.assertEqual(api.types, ['NOTE', 'ISSUE'])  # A name added in a second call is kept once.
        self.assertEqual(list(api.hooks), ['post_bash'])
        self.assertEqual(len(api.hooks['post_bash']), 1)
        self.assertIs(kb.plugins(self.root), api)  # Loaded once per project.

    def test_a_name_repeated_in_one_add_types_call_is_kept_once(self):
        self.use(extra=PLUGIN.replace("api.add_types('NOTE', 'ISSUE')", "api.add_types('NOTE', 'ISSUE', 'NOTE')"))
        self.assertEqual(kb.plugins(self.root).types, ['NOTE', 'ISSUE'])

    def test_no_plugins_means_no_additions(self):
        api = kb.plugins(self.root)
        self.assertEqual((api.commands, api.types, api.hooks), ({}, [], {}))

    def test_plugins_load_in_the_listed_order(self):
        self.use(extra=PLUGIN, refuse=FAILING)
        self.assertEqual(list(kb.plugins(self.root).commands), ['wordhits', 'refuse'])

    def test_a_command_name_used_by_two_plugins_is_refused(self):
        self.use(extra=PLUGIN, second=SECOND)
        code, result = self.cli('status')
        self.assertEqual(code, 2)
        self.assertEqual(result['error'], 'Plugin command wordhits is defined twice')

    def test_a_missing_file_a_missing_register_and_an_outside_path_are_refused(self):
        self.p.write_kit(plugins=['tools/missing.py'])
        code, result = self.cli('status')
        self.assertEqual((code, result['error']), (2, 'Plugin not found: tools/missing.py'))
        self.use(plain='VALUE = 1\n')
        code, result = self.cli('status')
        self.assertEqual((code, result['error']), (2, 'Plugin tools/plain.py has no register(api)'))
        for path in ('../outside.py', 'C:/outside.py'):
            with self.subTest(path=path):
                self.p.write_kit(plugins=[path])
                code, result = self.cli('status')
                self.assertEqual(code, 2)
                self.assertIn('Invalid workspace-relative path', result['error'])

    def test_a_failing_plugin_stops_every_command_not_just_its_own(self):
        self.p.write_kit(plugins=['tools/missing.py'])
        for args in (('get', 'D1'), ('lint',), ('search', 'fixture')):
            with self.subTest(args=args):
                code, result = self.cli(*args)
                self.assertEqual(code, 2)
                self.assertFalse(result['ok'])

    def test_the_catalogue_project_needs_no_plugin_for_its_built_in_types(self):
        self.assertEqual(kb.types(self.root), project.kb.TYPES)


if __name__ == '__main__':
    unittest.main()
