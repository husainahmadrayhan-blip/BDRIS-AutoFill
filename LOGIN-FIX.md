# Login Fix

Production login supports both modes:
- Admin-generated access link + username/password.
- Valid username/password without an access query parameter.

When an access link is supplied, it is still validated against the supplied user account. Device binding remains enabled.
