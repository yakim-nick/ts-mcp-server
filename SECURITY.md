# Security

This server hands file contents to an AI model, so its boundary matters. Please read the security
model in the README before pointing it at anything sensitive.

**Reporting a vulnerability:** please open a private security advisory on GitHub
("Report a vulnerability" on the Security tab) rather than a public issue.

Worth reporting: any way to read or list something outside the project directory, to read `.git`
or `.env*` files, to make a tool write or execute anything, or to leak absolute paths.
