-- Viewer insights: the IP address and the approximate place (Cloudflare geo) of each viewer.
ALTER TABLE watches ADD COLUMN ip TEXT NOT NULL DEFAULT '';
ALTER TABLE watches ADD COLUMN place TEXT NOT NULL DEFAULT '';  -- "City, Region, Country · Network"
