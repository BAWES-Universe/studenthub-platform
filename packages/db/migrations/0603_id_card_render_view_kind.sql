-- S8: printing a person's ID card reads their profile photo on the server. Each read is
-- recorded in staff_person_views as kind 'id_card_render' (viewer is the person themselves or
-- the staff member printing), with the photo's document type and version. Additive: the
-- existing kinds and rows are unchanged.
ALTER TABLE staff_person_views DROP CONSTRAINT staff_person_views_kind_check;
ALTER TABLE staff_person_views ADD CONSTRAINT staff_person_views_kind_check CHECK (kind IN
  ('civil_id_page','civil_id_image_issue','civil_id_image_deliver','person_page','person_document_issue','person_document_deliver','id_card_render'));
ALTER TABLE staff_person_views DROP CONSTRAINT staff_person_views_check;
ALTER TABLE staff_person_views ADD CONSTRAINT staff_person_views_check CHECK (
  (kind IN ('civil_id_image_issue','civil_id_image_deliver','person_document_issue','person_document_deliver') AND document_type IS NOT NULL AND document_version IS NOT NULL)
  OR (kind = 'id_card_render' AND document_type IS NOT NULL AND document_type = 'personal-photo' AND document_version IS NOT NULL)
  OR (kind IN ('civil_id_page','person_page') AND document_type IS NULL AND document_version IS NULL));
