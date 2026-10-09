import json, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
class Catalogue(unittest.TestCase):
    def test_sources_versions_and_licences_match(self):
        catalog=json.loads((ROOT/'.claude-plugin/marketplace.json').read_text())
        names=set()
        for entry in catalog['plugins']:
            self.assertNotIn(entry['name'],names);names.add(entry['name'])
            source=(ROOT/entry['source']).resolve()
            self.assertTrue(source.is_relative_to(ROOT))
            plugin=json.loads((source/'.claude-plugin/plugin.json').read_text())
            self.assertEqual(entry['name'],plugin['name']);self.assertEqual(entry['version'],plugin['version'])
            self.assertTrue((source/'README.md').is_file());self.assertTrue((source/'LICENSE').is_file())
            self.assertEqual(plugin['repository'],'https://github.com/sruthik27/claude-code-mods')
        self.assertEqual(names,{p.name for p in (ROOT/'mods').iterdir() if p.is_dir()})
    def test_bundle_dependencies_are_local_acyclic_and_complete(self):
        plugins={p.name:json.loads((p/'.claude-plugin/plugin.json').read_text()) for p in (ROOT/'mods').iterdir() if p.is_dir()}
        def walk(name,seen):
            self.assertNotIn(name,seen)
            for dep in plugins[name].get('dependencies',[]):
                self.assertIn(dep,plugins);walk(dep,seen|{name})
        for name in plugins:walk(name,set())
        self.assertEqual(set(plugins['all-mods']['dependencies']),set(plugins)-{'starter-kit','all-mods'})
        self.assertEqual(set(plugins['starter-kit']['dependencies']),{'lumen','insight-pane','changes','goal-meter','live-progress'})
if __name__=='__main__':unittest.main()
