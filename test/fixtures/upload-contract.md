# Photo upload gateway

This service accepts photos through FTP and HTTP, validates the tenant, stores
accepted bytes durably, and delivers them to the tenant CMS. Uploads must reject
empty files, invalid tenant credentials, and files larger than 100 MiB. The
accepts_upload helper is the existing input validation boundary. Its contract is
`tenant_ok && bytes > 0 && bytes <= 100 * 1024 * 1024`.

Meaningful tests, bug fixes, and behavior-preserving reliability improvements
support this purpose. No music, entertainment, or unrelated product feature has
been requested or approved. Passing coverage cannot justify bypassing validation.
