"""Apply researched recognition hierarchies without regenerating coaching criteria or phases."""
from __future__ import annotations
import copy
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def read(relative):
    return json.loads((ROOT / relative).read_text(encoding='utf-8'))


def validate(catalog, taxonomy):
    movements = {m['id']: m for m in catalog['movements']}
    placement = {}
    identifiers = set()
    for family in taxonomy['families']:
        if family['id'] in identifiers:
            raise ValueError('Duplicate family')
        identifiers.add(family['id'])
        for group in family['groups']:
            if group['id'] in identifiers:
                raise ValueError('Duplicate group')
            identifiers.add(group['id'])
            for mid in group['members']:
                if mid not in movements or mid in placement or movements[mid]['type'] != family['type']:
                    raise ValueError('Invalid, duplicated or wrong-type taxonomy member: ' + mid)
                placement[mid] = (family['id'], group['id'])
    if set(placement) != set(movements):
        raise ValueError('Missing taxonomy movements: ' + str(sorted(set(movements) - set(placement))))
    return placement


def main():
    research = read('ml/sports/recognition_taxonomy_sources.json')
    proposals = copy.deepcopy(research['taxonomies'])
    measured = read('ml/sports/squash/taxonomy.json')
    families = [{k: copy.deepcopy(f[k]) for k in ('id', 'name', 'type', 'groups', 'evidence') if k in f} for f in measured['families']]
    for family in families:
        for group in family['groups']:
            if 'pose_within_mean' in group:
                group.setdefault('evidence', {})['pose_within_mean'] = group.pop('pose_within_mean')
    # These exact labels exist in the pack but have no model training captures.
    families.append({'id': 'squash.family.dynamic.serve_and_return', 'name': 'Serve and return', 'type': 'dynamic',
        'groups': [{'id': 'squash.group.dynamic.serve_and_return.all', 'name': 'Serve and return',
                    'members': ['squash.serve', 'squash.return_of_serve']}],
        'evidence': {'basis': 'catalogue only; no usable training captures'}})
    proposals['squash'] = {'version': '1.1.0', 'levels': ['family', 'group', 'movement'], 'validation_status': 'provisional',
        'method': measured['method'], 'recognition': {'group_threshold': 0.6, 'family_threshold': 0.6, 'margin': 0.1, 'validation_status': 'provisional'},
        'families': families}
    similarity = read('ml/sports/squash/similarity_report.json')
    neighbours = {**similarity['static']['neighbours'], **similarity['dynamic']['neighbours']}
    staged = []
    for sport, taxonomy in proposals.items():
        relative = f'sport-packs/{sport}/movement_catalog.json'
        original = read(relative)
        catalog = copy.deepcopy(original)
        placement = validate(catalog, taxonomy)
        catalog['taxonomy'] = taxonomy
        for movement in catalog['movements']:
            mid = movement['id']
            movement['family_id'], movement['group_id'] = placement[mid]
            if sport == 'squash':
                edges = []
                for other in neighbours.get(mid, []):
                    oid = other['movement_id']
                    if oid in placement and oid != mid:
                        edges.append({'movement_id': oid, 'relation': f"pose_neighbour:{other['pose_distance']}", 'hard_negative': True})
                for oid, (_, group) in placement.items():
                    if group == placement[mid][1] and oid != mid and not any(e['movement_id'] == oid for e in edges) and len(edges) < 6:
                        edges.append({'movement_id': oid, 'relation': 'same_group', 'hard_negative': True})
                movement['similar'] = edges
        # The update must not change exact labels, coaching graphs or criterion links.
        strip = lambda ms: [{k: v for k, v in m.items() if k not in {'family_id', 'group_id', 'similar'}} for m in ms]
        if strip(catalog['movements']) != strip(original['movements']):
            raise ValueError('Unexpected change outside recognition taxonomy')
        staged.append((relative, catalog))
    for relative, catalog in staged:
        (ROOT / relative).write_text(json.dumps(catalog, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
        if catalog['sport_id'] == 'squash':
            manifest = read('sport-packs/squash/manifest.json')
            manifest['display']['description'] = (f"Squash sports engine: {len(catalog['movements'])} exact catalogue movements organised into "
                f"{len(catalog['taxonomy']['families'])} action families and "
                f"{sum(len(f['groups']) for f in catalog['taxonomy']['families'])} recognition groups. Grouping remains provisional.")
            (ROOT / 'sport-packs/squash/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            provenance = read('sport-packs/squash/provenance.json')
            for source in provenance['sources']:
                if source['id'] == 'data_capture_recordings':
                    count = similarity['static']['captures'] + similarity['dynamic']['captures']
                    source['citation'] = (f"ApexFormz corrected Data Capture squash recordings: {count} usable pose descriptors from one athlete; "
                        "research-constrained action families with measured same-view close groups. Expert-reference vectors are a separate export.")
                    source['accessed'] = research['researched_on']
            (ROOT / 'sport-packs/squash/provenance.json').write_text(json.dumps(provenance, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    receipt = {'status': 'passed', 'exact_labels_preserved': True, 'coaching_graphs_and_criteria_preserved': True,
        'research_sha256': hashlib.sha256((ROOT / 'ml/sports/recognition_taxonomy_sources.json').read_bytes()).hexdigest(),
        'catalogues': {c['sport_id']: {'movements': len(c['movements']), 'families': len(c['taxonomy']['families']),
            'groups': sum(len(f['groups']) for f in c['taxonomy']['families'])} for _, c in staged}}
    destination = ROOT / 'data/audit/recognition-taxonomy-refresh.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
