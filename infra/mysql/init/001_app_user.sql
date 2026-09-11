CREATE USER IF NOT EXISTS 'forge_app'@'%' IDENTIFIED BY 'forge_app_dev_only';
ALTER USER 'forge_app'@'%' IDENTIFIED BY 'forge_app_dev_only';
GRANT SELECT, INSERT, UPDATE, DELETE ON forge.* TO 'forge_app'@'%';
