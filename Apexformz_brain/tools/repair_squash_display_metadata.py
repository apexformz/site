"""Derive a named inventory revision; never rewrite hashed training manifests.

Names are copied by exact movement ID from the Data Capture catalog. This is a
display repair, not a movement relabel, coach review or encoding guess.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repair(inventory: dict, catalog: dict) -> tuple[dict, list[dict]]:
    if not str(catalog.get('source', {}).get('uri', '')).startswith('s3://apexformz-datacapture-'):
        raise ValueError('Expected Data Capture catalog provenance')
    names = {}
    for movement in catalog['movements']:
        if movement.get('sport_id') != 'squash':
            raise ValueError('Only squash catalog movements are supported')
        mid = movement['movement_id']
        if mid in names or not isinstance(movement.get('name'), str) or not movement['name'].strip():
            raise ValueError('Duplicate ID or missing canonical display name')
        names[mid] = movement['name']
    result, changes = copy.deepcopy(inventory), []
    for record in result['records']:
        uri = record.get('source', {}).get('uri', '')
        if not uri.startswith('s3://apexformz-datacapture-') or '/raw/squash/' not in uri:
            raise ValueError('Only squash Data Capture inventory records are supported')
        mid = record['source_movement_id']
        if mid not in names:
            raise ValueError(f'Missing authoritative catalog ID: {mid}')
        old, new = record.get('source_movement_name'), names[mid]
        if old != new:
            changes.append({'record_id': record['record_id'], 'movement_id': mid, 'previous_name': old, 'display_name': new})
            record['recorded_source_movement_name'] = old
            record['source_movement_name'] = new
            record['display_name_source'] = 'exact_id_datacapture_catalog'
    return result, changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, default=Path('data/squash/capture_inventory_resolved.json'))
    parser.add_argument('--catalog', type=Path, default=Path('ml/sports/squash/source_catalog.json'))
    parser.add_argument('--out', type=Path, default=Path('data/squash/capture_inventory_display_v2.json'))
    parser.add_argument('--audit', type=Path, default=Path('data/audit/squash-display-metadata-repair.json'))
    args = parser.parse_args()
    inputs = {args.inventory.resolve(), args.catalog.resolve()}
    if args.out.resolve() in inputs or args.audit.resolve() in inputs or args.out.resolve() == args.audit.resolve():
        raise ValueError('Outputs must be separate from all inputs and each other')
    original = json.loads(args.inventory.read_text(encoding='utf-8'))
    result, changes = repair(original, json.loads(args.catalog.read_text(encoding='utf-8')))
    provenance = {'kind': 'display_name_repair_only', 'created_at': datetime.now(timezone.utc).isoformat(),
                  'inventory': str(args.inventory), 'inventory_sha256': digest(args.inventory),
                  'catalog': str(args.catalog), 'catalog_sha256': digest(args.catalog),
                  'preserves_training_manifest_bytes': True, 'confers_coach_approval': False}
    result['display_metadata_revision'] = provenance
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    audit = {**provenance, 'output': str(args.out), 'output_sha256': digest(args.out),
             'records_changed': len(changes), 'movement_ids_changed': 0, 'changes': changes}
    args.audit.parent.mkdir(parents=True, exist_ok=True)
    args.audit.write_text(json.dumps(audit, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in audit.items() if k != 'changes'}))


if __name__ == '__main__':
    main()
