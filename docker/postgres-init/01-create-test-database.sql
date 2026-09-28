-- The backend suite needs its own database so it can truncate between tests
-- without touching development data. Creating it here means `docker compose
-- up` is enough; without this, the first pytest run fails with a missing
-- database rather than anything useful.
CREATE DATABASE canens_test;
