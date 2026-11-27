-- Per-owner document store (0661): the current documents of every person, metadata only, as one
-- relation a reader can join inside its own transaction. A sweep that reads it in one statement
-- reads one snapshot of every person (no page drift), and no row has to pass through a client.
-- It is driven by the slot history's active slots, so a filter on organization and type reads
-- only the people holding such a slot; retired versions, journals and blob references are never
-- exposed.
CREATE INDEX candidate_document_slots_active_idx ON candidate_document_slots (org_id, type, person_id) WHERE state = 'active';

CREATE VIEW candidate_current_documents AS
SELECT s.person_id,
       s.org_id,
       s.type,
       (d.doc->>'id')::uuid AS document_id,
       (d.doc->>'version')::uuid AS version,
       (d.doc->>'size')::integer AS size
  FROM candidate_document_slots s
  JOIN candidate_document_partitions p ON p.owner_kind = 'person' AND p.owner_id = s.person_id
  CROSS JOIN LATERAL jsonb_array_elements(p.snapshot->'state'->'documents') AS d(doc)
 WHERE s.state = 'active'
   AND d.doc->'scope'->>'orgId' = s.org_id
   AND d.doc->>'type' = s.type;
