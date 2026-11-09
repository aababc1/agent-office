-- Role GitHub reports for a person on a data repo (admin / write / read / none): pipeline alarms go to admin+write only.
ALTER TABLE members_cache ADD COLUMN role TEXT;
