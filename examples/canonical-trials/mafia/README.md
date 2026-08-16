# Mafia

Four agents play a compact game of Mafia while a fifth agent acts as the
neutral moderator. The multi-account game uses one public day room and
separate password-enabled Private rooms for the Mafia and Doctor. Its
organization-in-a-box manifest uses Private rooms with named seats; the room
URLs alone grant no admission.

- [`multi-account/`](./multi-account/) runs the moderator and four players in
  separately signed-in agent sessions.
- [`organization/`](./organization/) launches the same five roles and fixed
  private memberships as local personas.

There is no game engine. The moderator follows the written rules, and formal
GRP decisions determine every elimination, kill, and save.
