-- Contract P-1: an export kind may write its own format (an XLSX bank file, a bank's fixed
-- text format) instead of CSV. The bytes stay in csv_bytes under the same size cap; the
-- content type and download name are stored beside them. Both are null for a CSV export.
ALTER TABLE exports
 ADD COLUMN content_type text CHECK (content_type ~ '^[a-z]+/[a-z0-9][a-z0-9.+-]{0,99}(; ?charset=utf-8)?$'),
 ADD COLUMN file_name text CHECK (file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
 ADD CONSTRAINT exports_own_format_pair CHECK ((content_type IS NULL) = (file_name IS NULL)),
 ADD CONSTRAINT exports_own_format_created CHECK (content_type IS NULL OR outcome = 'created');
