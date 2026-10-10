-- Run while connected AS dollas_app (DATABASE_URL_APP). Every column after
-- current_user must be false; app startup refuses to serve otherwise.
SELECT
  current_user,
  r.rolsuper AS superuser,
  r.rolbypassrls AS bypassrls,
  r.rolcreaterole AS createrole,
  r.rolcreatedb AS createdb,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser')
       THEN pg_has_role(current_user, 'neon_superuser', 'MEMBER') ELSE false END AS neon_superuser,
  (SELECT count(*) FROM household) AS households_visible_without_a_member
FROM pg_roles r
WHERE r.rolname = current_user;
