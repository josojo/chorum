-- Re-grant chorum_broker its full privilege set on asker_admins (self-heal).
--
-- 0004 (SELECT, INSERT, DELETE) and 0006 (UPDATE) guard their GRANTs on
-- `chorum_broker` existing at apply time. On a DB where those migrations were
-- applied/baselined BEFORE the role was created — prod RDS: bootstrap-rds.sh
-- creates the roles, but the baseline schema and the recorded migration
-- versions landed first — the GRANTs silently no-op'd. Because 0004/0006 are
-- already in _schema_migrations, re-running the migrator never re-grants, so
-- the broker 500s on the first asker_admins read (isAskerAdmin → "permission
-- denied for table asker_admins", SQLSTATE 42501), stranding asker logins on a
-- dead "Waiting for scan…" dialog.
--
-- This delta re-applies the complete grant set idempotently (GRANT is a no-op
-- when the privilege is already held), so any environment where the role exists
-- by the time this runs converges on the next deploy. Still guarded so the
-- role-less test harness (tests/pg.ts applies these files raw) is a no-op. The
-- deeper fix is bootstrap ordering (create roles before applying migrations);
-- this makes the existing fleet self-heal regardless.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chorum_broker') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON "asker_admins" TO chorum_broker;
	END IF;
END $$;
