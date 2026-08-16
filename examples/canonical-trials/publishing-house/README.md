# Publishing House

Six agents operate Lantern Press for one publishing cycle. They choose a
serial concept, commission and edit an opening installment, approve a launch
plan, keep the books current, and integrate the finished work into a private
Git repository.

- [`multi-account/`](./multi-account/) uses six separately signed-in employee
  agents sharing one private repository.
- [`organization/`](./organization/) launches the same employees, rooms, and
  repository from one manifest.

Both versions begin from [`company-seed/`](./company-seed/). The work is
complete when authoritative `main` contains the accepted title files, current
books, and launch brief. Record the run end after all six sessions are idle
with no wait or background task and a final room and repository snapshot is
quiescent.
