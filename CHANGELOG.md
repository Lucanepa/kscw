# Changelog

All notable changes to Wiedisync, the KSC Wiedikon members' platform. This file is the curated, user-facing release record (English, semver), mirrored in the in-app "What's New" (`src/modules/changelog/ChangelogPage.tsx`). For commit-level detail see `git log`; for the operator/deploy history see `docs/DEVLOG.md`.

## v2.7.2 — 2026-09-08

### Fixes

- **"Fix groups" no longer lists the rows it has just fixed.** *Superadmin tool — Admin → Data health → ClubDesk sync.* The group findings are read from the last sync down, so a run that wrote to ClubDesk left exactly the same rows on screen afterwards — which reads as "nothing happened" and invites another run. Wiedisync's copy of the register now takes on what was actually written, so a fixed row disappears when it is fixed. The unattended Sunday stray sweep had the same blind spot, for a week at a time, and is covered too.
- **"Fix groups" now has two clearly separate steps.** The window used to render as one flat panel that never moved: after a preview succeeded it still read "Preview first, then commit", still said "Review the preview before you commit", and still offered "Run preview" beside the commit button — so the step you had just finished was still the instruction on screen. It now says which of the two steps you are on, and offers one obvious action: preview, then commit, then close. ⚠ It also no longer lets a commit write rows the preview never showed you — changing the selection after a preview used to commit the new selection while the confirm dialog still counted the old one.
- **Junior basketball players are no longer listed in the Classics league squads.** Every junior sat in `H-Classics 1LR` or `Damen D-Classics 1LR` alongside their own team, which is a league umbrella rather than a squad — so a 10-year-old appeared to be on a men's team. Both squads are adults-only now, in the current and the previous season; a junior who really plays up keeps their place.

## v2.7.1 — 2026-09-08

### Fixes

- **Opening an activity from the home page no longer flashes an empty answer.** Tapping a training, game or event opened its panel with all three Yes / Maybe / No buttons greyed and unselected, and your saved answer only snapped in a moment later — which read as "you have not replied yet" and invited a second tap. The home page already knows every answer before it draws a single row, so the panel now opens with yours already shown. The participation counters and the "Absent" note open filled in for the same reason.
- **Dates in News are written the same way everywhere.** The same list showed `09.09.26`, `03.10.2026` and `03.10.26` side by side — three parts of the app writing the same kind of line with different years. All of them now use the Swiss `dd.mm.yyyy` the rest of Wiedisync uses, and the notices already on the page were corrected too.
- **A new or updated event no longer announces the wrong time.** The notice for an event starting at 19:00 said 17:00 in summer and 18:00 in winter, and an event just after midnight was announced on the day before.

## v2.7.0 — 2026-09-08

### The ClubDesk sync tells you what it is doing

*Superadmin tool — Admin → Data health → ClubDesk sync.*

- **Every step of the sync path now opens the same window.** Which step it is, what it does, a progress bar, a live log, and one button to move on. Before, the two "sync down" steps ran under the card, deciding happened in a table further down the page, and "Sync up" and "Fix groups" each opened a different-looking dialog.
- **The progress bar measures the sync, not the step you are on.** It moves with the scrape itself — logging in, opening the contact list, waiting for the export, loading it — instead of jumping a fifth at a time. A run that has stalled and a run that is nearly finished no longer look identical.
- **The sync's own log is on screen while it runs,** so a failure can be read where it happened instead of on the server. The same applies to the push and to the group fix, which reports contact by contact.
- **The "Fix groups" button above the path is gone.** It ran, out of order, the job the path already runs last — and last is where it has to be, because a contact created by a push can only be found in ClubDesk once the push has been read back.
- **Departed members can be deactivated in bulk.** ClubDesk records an Austritt date and the sync board lists them; one button now sets them all to not-a-member and inactive and drops them from active rosters, instead of twelve trips through a table pressing the same button.

### Fixes

- **A blank on our side is no longer reported as a disagreement.** Two members created in ClubDesk by a push came back with their joining date, membership status and section, and the review queue announced six "values disagree" against six empty cells. It now says "Ours is empty", which is what it is.

## v2.6.1 — 2026-09-08

### Fixes

- **A form whose deadline has passed no longer appears under "Forms to fill".** A tournament sign-up that closed in July still had a live Edit button on the home page, and tapping it failed with a generic error every time.
- **A form that has closed now says so.** Submitting to one that closed while you had it open reported only "Could not submit. Please try again." — advice that could not have worked.
- **A public form link for a form past its deadline now says the form is not available,** instead of letting you fill the whole thing in and refusing it at the end.

## v2.6.0 — 2026-09-07

### The SQL console suggests the right thing

*Superuser tool — Admin → SQL workspace.*

- **Typing a table's name or its alias now suggests only that table's columns.** `mt.` after `FROM member_teams mt` offers member_teams and nothing else; before, it offered every column in the database and let you pick one that did not exist on that table. The abbreviation works even before the FROM line is written.
- **Values are suggested too.** After `sport = ` the console offers `'volleyball'` and `'basketball'` — the values the column actually holds, read from the database rather than guessed.
- **A suggestion says which table it comes from.** Columns are offered, and inserted, already qualified.
- **The explanation panel no longer covers the suggestions on a phone.** It sat on top of the list it was explaining.
- **A failed query now offers "Did you mean…".** A mistyped column is matched against the tables that query actually joined, and one tap corrects it.
- **Ask AI writes the values correctly and remembers the conversation.** It is given the real values each column holds, so it writes `'volleyball'` and not an invented `'vb'`, and it knows today's date, so "this season" means the current one. Your last few questions stay in context, so a follow-up refines the query instead of starting over.
- **The console works on a phone.** The three controls share one bar, write mode is a switch, and the schema browser — which was desktop-only — opens in a panel showing each column's type, keys and values.

### Fixes

- **The RSVP row no longer reads as unanswered while your answer is still loading.**
- **The officials on a game no longer read as "nobody assigned" while the screen is still loading.** The heading appeared over an empty list, and if the second request failed it stayed that way.
- **A team that is full is now refused by the contact form as full.** The website already hid a full team's contact button, but a bookmarked or cached page could still reach the form; only closed basketball youth teams were being turned away.
- **Date of birth sits left of the shirt number on the scorer's match sheet,** matching the coach's roster and the order a scorer reads it in.

## v2.5.0 — 2026-09-07

### The match sheet checks itself

- **The match sheet now shows, next to each nominated player, whether they actually said they are coming.** A green tick means confirmed, an amber mark means "maybe" or no answer yet, and a red cross means they declined — nominated in Volleymanager but not turning up. The Einsatzliste still decides who plays; this only checks it against the replies.
- **The same mark appears on the emergency bench list, where it answers the opposite question: who confirmed but was never nominated..**
- **Where there is no Einsatzliste to check against, the column stays hidden rather than showing a row of ticks that verified nothing..**

### Admin mode now means what it says

- **Admin powers now require admin mode to be switched on, everywhere.** Fifteen places let an administrator edit any team’s roster, cancel activities, open other teams’ sign-up lists or export club-wide data while admin mode was off. If you are an administrator and something you could do before now seems missing, switch admin mode on.
- **Identity documents can now only be opened by a team’s own coaches and team responsibles.** Administrators were shown the button, but the documents are end-to-end encrypted and an administrator holds no key — so it could never have worked, and it reported "0 documents downloaded", which is the message meaning nobody had uploaded one.

### Fixes on the game screen

- **The buttons on a game no longer change while the screen finishes loading.** For a coach the first button used to switch from the attendance list to the match sheet, with two more appearing above it — long enough that a tap could land on the wrong one.
- **A scorer no longer sees a "View roster" button that only ever opened an empty list.** The match sheet is the one they need.
- **The venue no longer appears a moment after the rest of a game.** Opened from your duty list, the hall and address were fetched only by a second request, so they filled in after the card was already on screen.
- **The match sheet now states the right times when it is not yet available.** It claimed to open three hours before the game; it opens 40 minutes before for the scorer and earlier for the team.

## v2.4.2 — 2026-09-07

### The school’s hall calendar

- **Basketball home games are no longer announced to the school as volleyball.** The Kantonsschule Wiedikon hall calendar took the sport from where a fixture came from rather than from the team playing it, so every hand-entered basketball game was published as "VB" — all five upcoming home games at KWI.
- **A basketball home date agreed with the opponent now reaches the school’s hall calendar.** Until now only fixtures already published by Basketplan did, so eight agreed dates held the court in wiedisync while the hall administration’s calendar showed it free. Dates still being negotiated stay off it.
- **A game that takes both halves of the hall now says so.** Four upcoming fixtures use the full hall and were listed under one half only, which read as though the other were free.

## v2.4.1 — 2026-09-06

### Basketball planner fixes

- **A game placed in the Spielplansitzung planner can now be edited from the calendar too.** Tapping the date showed "Edit in the planner" next to it and then did nothing; that row now opens the same editor the planner grid uses (team, opponent, home/guest game, note, remove).
- **A team that already hosts on a date is no longer offered more slots on it.** The slot generator knew a team could not host while playing away, but not while already hosting — so it kept suggesting the rest of the day. It applies immediately, without re-generating the slot list.

## v2.4.0 — 2026-09-03

### Basketball games can be corrected

- **A game on the basketball calendar can now be edited and deleted from the day it sits on.** Tap the date, then "Edit" on the game: home or away, the date, the kick-off time, the hall and the opponent are all changeable. Until now a game could only be created — a fixture entered on the wrong side, or with a time that later moved, stayed wrong.
- **Home games now appear on the basketball calendar.** A home game recorded on the game calendar used to be invisible in the whole basketball section, even while it occupied the club's biggest court.
- **A basketball home game in KWI now blocks that court for volleyball**, the same way a game placed in the Spielplansitzung planner already did. Both sports read one list, so a court can no longer be offered to a volleyball opponent while a basketball game is standing on it. The planner grid and the ProBasket availability form stop offering it too.
- **The manual game calendar is now reachable from the basketball section**, in the tab bar next to the calendar, opening with the basketball games already filtered.

## v2.3.0 — 2026-09-02

### A member who has left is now one button

- **The member page in the Data Explorer has a "Member left" button.** It writes the whole departure at once: the register status, the exit date, club membership and app access switched off, and the person comes off their current-season team rosters. Past seasons are kept — the match sheets and the "who played for D2 in 2024/25" answer live there.
- **Until now this had to be done column by column.** Switching "Club membership" off on its own left the club register still saying the person is a member, with no exit date, and Data Health then reported them under "Former members without an exit date".
- **A departure typed in here now clears the current team rosters**, exactly as a departure coming from ClubDesk always has. The same event used to have two different outcomes depending on which side it was entered from.
- **Deleting a member now says on screen that the ClubDesk contact stays.** Nothing in wiedisync ever deletes a contact from the club register — so if somebody has simply left the club, "Member left" is the action that ends the membership properly and pushes the status and the exit date into the register at the next approved sync-up.

## v2.2.0 — 2026-09-01

### One login for the whole family

- Parents who look after more than one child in the club can now do it from a single login. A bar at the top of every screen shows whose account you are using; tap it and pick another child. No second password, no logging out and back in.
- Each child keeps her own separate member record — her own team, her own RSVPs, her own fees and licence. Nothing about that changes. What changes is only who is allowed to sign in and act for her.
- Children who are looked after this way have no password at all and cannot sign in. That is deliberate: it means one fewer set of login details in circulation for a twelve-year-old, and a parent's access can be withdrawn completely at any time.
- The child's name appears inside the buttons themselves — "Mila is coming" rather than just "Yes" — so it is under your thumb at the moment you decide, and there is no doubt about who you just answered for.
- A child old enough to have her own login can remove a parent's access herself, from her profile. Private messages stay private either way: a parent managing RSVPs cannot read her child's conversations with teammates and coaches.
- Club admins can set families up under Options → Households.

## v2.1.8 — 2026-09-02

### A fine the team owes now reaches the team

- **Open fines appear on the home page.** Your own open fines and the fines your team owes as a team are shown together at the top, split so it stays clear which is which — the card only appears when something is actually open.
- **A fine issued against a whole team now notifies that team.** Team fines (a forfait, a missing scorer, a late match sheet) are paid out of the team fund and belonged to no single player, so nobody was told they existed: they were visible only to whoever happened to open the fines page. Everyone on the team — players and staff — now gets the notification when one is issued, marked as paid, or waived.
- **Your fines list shows the team fines of your teams**, marked "Whole team". They are kept out of your personal outstanding total, which stays exactly what you owe yourself.
- **Fine notifications are translated and now open the fines page.** They used to show an internal code instead of a message and took you to the home page when tapped.

## v2.1.7 — 2026-08-28

### The duty overview updates as soon as you roll out

- **After rolling out a duty plan, the overview tab now shows what you just saved.** It used to keep showing the picture from when you opened the page, so a duty team you had changed still appeared under its old team until you reloaded — the one view meant to confirm what is committed was the one showing stale information. The change itself was always saved correctly; only the display lagged.

## v2.1.6 — 2026-08-28

### A cup home game can now be given a duty team

- **Cup home games can be assigned a duty team and a person** on the scorer assignment page. Until now the row was read-only: nobody is summoned for cup duty by default, because the playing team covers its own cup match — but there was no way to put somebody on it when you wanted to. The row now has the same team and person pickers as every other game, and stays marked "On call" for as long as you leave it empty.
- **Once you do assign somebody, the duty behaves like any other**: it appears on their scorer page and it counts toward that team's share of the season's duties. Recomputing the plan keeps it.

## v2.1.5 — 2026-08-28

### Cup home games show up in the duty overview

- **A home cup game no longer disappears from the duty overview** on the scorer assignment page. Nobody is summoned for cup duty — officials are on standby instead — and the overview only listed games that had a duty team, so a cup game we host vanished from the one view used to check that every game is covered. It now stands in the list as "On call", and is not counted as an unfilled duty.

## v2.1.4 — 2026-08-28

### Changing your profile photo works with a photo from your camera

- **Picking a photo straight off a phone or camera now works.** Anything over 5 MB was refused, and almost every photo a modern camera takes is bigger than that — so choosing one appeared to do nothing at all, and the old picture stayed. The app now shrinks the photo for you before uploading it, so any size goes through.
- **On the rare occasion a photo really cannot be used, you are told so next to the button** instead of in a message far below the bottom of the form, and picking the same file again works rather than being silently ignored.
- The same fix applies to the member photo in the admin member editor.

## v2.1.3 — 2026-08-27

### The reply counts on a game match the roster again

- **A game card no longer counts a "no" from somebody the roster does not list.** Guest players cannot be entered on a match sheet, so they are left off every game roster — but when one of them filed a holiday the app still wrote them a "no" for each game in that window, and the red counter on the card counted it. A card read "1 declined" over a roster where nobody had declined. Those replies are gone, and no new ones are written.
- **One player was also carrying a "no" on the other team's copy of the H1 v H3 derby**, left behind by a sync fault in July that briefly moved the fixture between the two teams. Removed.

### A game you were called up to shows on the games page

- **Being called up to another team's fixture now puts it on your games page**, where it belonged all along — until now it appeared on your home page and in your calendar but never in the games list, so the whole H3 squad opened up for H1's cup tie could not find it. It stays there whichever team you filter by: a call-up is yours personally, so no team chip hides it.

## v2.1.1 — 2026-08-26

### The app no longer hangs on the loading screen

- Logging in and then watching the logo spin — sometimes for minutes, sometimes until the page gave up — is fixed. The app was asking the database one question that had quietly become enormously expensive, and at busy times, like everyone checking in before training in the morning, those questions piled up until nothing got through. It now answers in well under a second.
- Who has replied to a club or multi-team event is visible again. On events that span more than one team — the Photoday, a mixed tournament, a Trainingswochenende — you could only see the replies of people on your own team, so a well-attended event looked like nobody had answered. You now see the whole list.
- Players called up to another team's game, and that team, can see each other's replies again — so the coach picking the squad sees a full roster instead of blanks.
- Various pages now ask the server for far less than they used to. Trainings, games, the scorer list and team chat used to reload everything whenever anyone anywhere changed a reply; they no longer do.
- The notification bell and the news feed now agree with each other: reading a news item marks it read in both places straight away.

### The sign-up form asks which federation licensed you first

- **"None" is gone from the federation-of-origin question.** Nobody is without a federation: if no association has licensed you before, the one issuing your first licence — Swiss Volley or Swiss Basketball — *is* your federation of origin, so the answer is Switzerland. It was the first option in the list and was being chosen by most people who answered, nearly all of them juniors getting their first licence from us.
- **The question changed with it: which federation licensed you *first*, not which one licensed you at 14.** Under the old wording someone first licensed abroad at 20 truthfully answered "nobody at 14", and the club never learned to request their transfer certificate before they could play.
- **Members who had answered "None" now read as Switzerland**, except where their nationality is not Swiss — those appear on the club's transfer list so somebody asks them, rather than the club quietly assuming.

## v2.1.0 — 2026-08-26

### Games, trainings and events can carry a meeting time

- **When a team meets before the start — Besammlung — is now on the record** next to the start time, instead of living in the training notes, a chat message, or nobody's head. It shows in the game, training and event details, and in the calendar.
- **Games default to an hour before the first whistle and trainings to ten minutes before the start**; both are already filled in on every existing game and training. Events have none unless you set one, because most of them do not need one.
- **The coach sets how long before the start the team meets, and the app works out the clock time.** That means a game moved by Swiss Volley brings its meeting time with it: a 16:00 game meeting at 15:00 that moves to 18:00 now meets at 17:00, with nobody having to remember to change it.
- **Events take a plain time instead,** so an all-day tournament can still say "be there at 08:30" — the case where a meeting time matters most.

## v2.0.0 — 2026-08-26

### Coaches who set up their key late can be given access to identity documents

- **An identity document is locked to the people named when it is uploaded**, and nobody else — not the club, not an administrator. That is deliberate, but it had a sharp edge: a coach who set up their identity key *after* their players had uploaded was never given a key, so they could open nothing. It only became apparent when they tried to show the documents at a match. One team had nine documents its own coach could not open.
- **Your profile now tells you when someone on your team's staff cannot open your document,** and gives you a button to grant them access. Your document is not uploaded again, and nobody outside your own coaches and team responsibles can ever be added.
- **A coach or team responsible who can already open a team's documents can restore access for a colleague across the whole team at once,** from the team page. This is the only way it can work: the club's servers have never held the key, so only a device that can already open a document is able to pass access on.
- **If you cannot open a player's document at a match, the app now says so** and tells you how to get access. Before, it simply downloaded nothing and gave no reason.

### You can see who can open a team's identity documents

- **Coaches and team responsibles have a new "Document access" view** on the team page, listing every uploaded document and exactly who can open it. Being on a team's staff does not by itself grant access, and until now there was no way to tell the difference.
- **It distinguishes the cases that need different action:** who can open it, who is waiting for access to be restored, who has not set up an identity key at all — which nobody else can fix for them — and who has left the team but still holds access, because removing someone from a team does not reach into their phone. Only uploading the document again withdraws that.

## v1.99.1 — 2026-08-25

### Your team's calendar shows every game

- **A team's games now come from the official Swiss Volley fixture list** instead of being pieced together from the hall bookings made while arranging them. Any game that never went through our own booking process was simply missing — the H1 v H3 derby above all, which by definition has no booking because both sides are us. H3's calendar showed 17 of its 19 games; the missing two were the derby and an away game the opponent scheduled directly.
- **Kick-off times and venues are the federation's own.** The calendar used to show the hall reservation window rather than the real start — 19:30 for a game that starts at 20:00 — and away games showed no venue at all. If a game is moved after we booked the hall, the calendar now follows the move instead of showing the old date.
- **A game says who you are playing.** Every entry on a team's calendar used to read that team's own name, over and over, with the opponent hidden in a tooltip.

## v1.99.0 — 2026-08-25

### The J+S export matches what the national database accepts

- **Training length is now always reported as 90 minutes.** Jugend+Sport only accepts 60, 75 or 90, and we were sending the measured block length — 105 or 120 — which made the national database refuse the file. Matches no longer carry a duration at all, as the J+S rules require.
- **Full-day activities are reported as 4 or 6 hours,** the only two lengths J+S allows. A four-and-a-half-hour event used to be sent as 4.5 hours and rejected.
- **The export now warns you before you download** if any training has no location or no time. Both are mandatory, and until now the file was only refused after you had uploaded it.

### The training plan runs to the summer holidays

- **Trainings are now created for the whole planned season instead of the next twelve weeks.** The hall plan runs to August 2027, but only about three months of it existed as actual sessions — so the calendar, and the J+S activity list built from it, ran out in November for most teams and at the end of May for the rest.
- **Every team's plan now reaches mid-July 2027,** stopping by itself at the summer holidays. School holidays, Sportferien, Easter, Whit Monday and every hall closure are skipped, as before.

## v1.98.1 — 2026-08-25

### A failed ClubDesk sync now says so

- **A sync that failed used to look like one that worked.** The time under the button was stamped whether the sync succeeded or not, so a failed run showed a fresh "last sync" and the club register quietly stayed out of date. That line now only ever shows the last sync that actually succeeded.
- **When a sync does fail, the page says why** — whether ClubDesk did not respond, refused the login, or our own tool could not start — instead of pointing at a log file only a developer can open.

## v1.98.0 — 2026-08-25

### Former members' details are deleted after a year

- **When somebody leaves the club, their contact and payment details are now erased twelve months later.** Bank details, AHV number, phone, address and email address are removed for good. Name, date of birth, the teams they played in and their dues history are kept, so the club's own record of who played when stays intact.
- **Nothing is deleted automatically.** Each erasure is a decision an administrator takes, and it is recorded in the audit log. Invoices keep the address they were issued to, so the club's accounts stay complete.

## v1.97.1 — 2026-08-25

### The trainings list stops asking the same question 47 times

- **Pages with a long list of trainings, games or events were slow to settle, worst of all on a phone.** Every single card asked the server on its own whether you were marked absent that day. A season view of the trainings page meant 47 separate questions where one would do — 94 of that page's 155 requests, all for an answer the app could have looked up once. The requests then queued behind each other, so the same trivial lookup that normally takes 50 milliseconds was taking 650.
- The app now fetches your absences once and works out the rest itself. Nothing changes about what you see — the "Absent" and "Unavailable" markers behave exactly as before, they just appear without the wait.

## v1.97.0 — 2026-08-24

### When somebody leaves the club, the app notices

- **A contact deleted from the club register no longer goes unnoticed here.** If somebody is removed in ClubDesk, the app used to keep them on their team, on the team's mailing list and in the roster counts indefinitely — it could see the link was broken but had nothing to offer about it. An administrator now gets the choice: restore the link, or end the membership, which also takes the person off every current team.
- **Departures are now dated.** The app records when a membership was switched off, so the club can tell how long a former member's data has been kept. That is the first step towards deleting what it no longer needs.

## v1.96.1 — 2026-08-20

### Avatars stay round when there is no photo

- **A member without a photo showed a squashed oval, not a circle.** In a team roster on a narrow screen the initials badge was pressed down to 19 of its 32 pixels wide while keeping its full height. Members *with* a photo were never affected, which is why it looked arbitrary: a browser lets a circle of text shrink to the width of the text, but gives a picture its full size to hold on to.
- The badge now keeps its shape everywhere it appears — team rosters, the add-member list, the profile page, the profile editor and the avatar in the top bar. On a tight row the name wraps one line further instead, exactly as it already did next to a photo.

## v1.96.0 — 2026-08-15

### Your invoice now shows what goes to Swiss Volley

- **The membership fee is itemised.** A volleyball invoice used to show one number; it now shows the club's own fee and the Swiss Volley licence separately — CHF 330 plus a CHF 110 regional licence, for example, instead of a bare CHF 440. **Nobody pays more:** the licence was always inside the fee, and the total is unchanged.
- **The website said the opposite.** kscw.ch stated that licence fees were *not* included in the membership fee and were billed alongside it. They have always been included, and no invoice ever carried a separate licence charge. The fee tables now show the licence share per category and the note has been corrected, for volleyball and basketball alike.

## v1.95.0 — 2026-08-15

### A free membership now gets a bill that says so

- **If your membership is free, you get an invoice like everybody else — for CHF 0.** It shows what a membership like yours would have cost and the exemption that cancels it, so "CHF 0.00" reads as a decision the club made rather than something that went wrong.
- **Nothing to pay and nothing to do:** it arrives already marked as paid, with no payment slip and no email. You will find it under Finances → My dues alongside your other invoices.

## v1.94.0 — 2026-08-15

### The Database table only draws the rows you can see

- **First paint is down to about a tenth of a second.** The table used to build all 711 rows whether or not they were on screen. It now renders only the visible ones: 0.4 s to 0.1 s on the default columns, and 0.8 s to 0.16 s with thirty columns showing. The page holds ~800 elements instead of ~13,000, so scrolling, sorting and searching are lighter too.
- **Nothing about using it changed.** Scrolling reaches every member, the scrollbar is the right length, the header and the name column still freeze, grouping still shows its section headings, and "select all" still selects all 711 and not just the visible ones.

## v1.93.2 — 2026-08-15

### The Database table opens about three times faster

- **The table was building an editor for every cell, even though you were only reading.** With 711 members and the new ten-column default that is ~7,800 editors, and every date cell carried a whole calendar. It now draws plain text until you switch editing on: first paint went from 1.1 s to 0.4 s, and from 2.0 s to 0.8 s if you have thirty columns showing.
- **Switching editing on is quicker too** — a date cell opens its calendar when you click it, instead of all 711 opening one in advance.
- Nothing about what you see changed: same columns, same Swiss dates, same values.

## v1.93.1 — 2026-08-15

### Honorary, passive, gap year and former, per sport as well as club-wide

- **Each sport now lists its own register states.** Volleyball and Basketball each hold Honorary, Passive, Gap year, Former and Non-members alongside Teams, Officials and Staff — so "which of our volleyball people are on a gap year" is a group rather than a filter you build yourself.
- **The club-wide lists still count everybody**, including the people already shown under a sport. They answer a different question: the club has 12 honorary members, of whom 3 are on the volleyball side and the rest belong to no section.
- **Each sport's "Other" got smaller and more useful** — 60 to 38 for volleyball — because a passive or gap-year member is now named as such instead of falling through to the leftovers.

## v1.93.0 — 2026-08-15

### Every datapoint as a column, a working set of defaults, and an edit switch

- **The table opens with ten useful columns instead of two.** Name, teams, email, phone, address, postal code, city, birthdate and register status — the set the club actually works in. A fresh browser used to show two name columns and nothing else until you went shopping in the column list. ⚠ This resets a column selection you had saved; pick your columns once more and it sticks.
- **The column list offers every datapoint the page holds — 72 of them, up from 35.** Nickname, section, licence status, trainer licences, ClubDesk flags, the shell-account fields and the rest are all columns now, read-only. What is not there is what the page does not load: about 46 more datapoints, mostly finance and notification settings, sit behind narrower permissions and asking for them would break the page for anyone who is not a full admin.
- **The column list has a search box, grouped results and one-click show/hide.** It searches German too — type "Geburtsdatum" or "Lizenz" and the right field comes up, even though the labels are English. "Show all" applies to whatever the search is showing, so "type ahv, show all" is two clicks rather than a hunt through a hundred checkboxes.
- **Editing is now a switch you turn on.** The table is read-only when you arrive, with an Edit button at the top; cells become editable, and the selection ticks for bulk actions appear, only once you press it. It never stays on between visits — this is a page you mostly scroll, and a stray click on a cell should not change the club's register.

## v1.92.0 — 2026-08-14

### Each sport owns its own groups, and the table view is grouped the same way

- **Volleyball and Basketball each hold their own Teams, Officials, Staff and Other**, instead of "Volleyball officials" and "Basketball staff" sitting in one flat list next to Gap year. Open a sport and everything about that sport is under it.
- **"Other" is now what is left over, not "has no team".** Somebody who scores but plays for no squad is under Officials, where you would look for them, and no longer padding the list you scan for the unexplained. Volleyball's Other went from 90 people to 60.
- **The table view's sidebar uses exactly the same groups as the tree**, so picking a group in either place means the same thing. It was a flat list of teams before, and there was no way to see, say, every basketball official as a table.
- **A group's count and its rows now agree.** Picking Former members showed 29 in the sidebar and 7 rows, because the group is built from everybody while the table was showing current members only.

## v1.91.0 — 2026-08-14

### The Database tree now mirrors the club, not just the roster

- **The member tree had three groups — Volleyball, Basketball and "Other" — and it worked out which one you were in from your roster teams alone.** Anyone without a roster row landed in "Other" no matter what the club knew about them: passive members, referees, new signups, and every coach and team responsible in the club, because coaching links are not roster rows. It now reads section and fee category too, so a member with no team lands in their own section under "No team".
- **There are real groups now, close to the ones in ClubDesk.** Volleyball and Basketball open into their teams. Alongside them: volleyball and basketball officials (scorers, referees, and the OTR1 / OTR2 / OTN1 / OTN2 grades), volleyball and basketball staff (coaches, team responsibles), club board, honorary members, passive members, gap year, former members, non-members and schedulers.
- **You appear in every group you belong to.** A player who also coaches and sits on the club board shows up in all three, the way ClubDesk works. Group counts are of people, not of entries, so nobody is counted twice in the number at the end of a row.
- **Former members are on the page at last.** The Database page only ever loaded current members, so 22 of the 26 people the register lists as "Ehemaliges Mitglied" were not there to be found. Everyone is loaded now, with an "Active club membership" filter switched on by default — the same people on screen as before, except the filter is one you can see and clear.
- **A group nobody can place is still shown, as "Unassigned".** It is four people today. That is a data question worth seeing rather than hiding.

## v1.90.0 — 2026-08-14

### "No transfer needed" is a decision you can record

- **The transfers page has a third status: "Not needed".** Until now the only way to take somebody off the transfer worklist was to change their federation of origin — which is the member's own answer about where they were first licensed, not a checkbox for clearing a task list. Ruling a transfer out is now its own decision, recorded next to who made it, and it leaves their federation of origin exactly as it was.
- **Members Swiss Volley already licenses as Swiss come off the worklist by themselves.** Swiss Volley is the body that would ask for the transfer certificate, so where their register counts somebody as Swiss there is nothing for us to chase — whether that is because no transfer was ever needed or because one already went through. Those members now say so instead of sitting on the list looking untouched.
- **Except the ones you are chasing anyway.** Marking somebody Pending or Done always wins over the automatic answer, in both directions.
- **The Volleymanager comparison table has a Decision column.** Where our record and Swiss Volley's disagree, you can now settle it on the row that raised the question rather than somewhere else. The disagreement itself stays on screen afterwards — it is still the evidence that one of the two registers needs correcting.
- **Members licensed in Switzerland can now be marked as being chased.** That is the case that had nowhere to go before: our record says Switzerland, Swiss Volley's says a foreign federation, and nobody was following up a transfer that might well be required.
- **Nothing disappears quietly.** Everyone taken off the worklist is listed under it, with the count in the heading and the decision reversible — a shorter list always says why it got shorter.

### Database view reads properly

- **Values are shown as words instead of database codes.** Sex, language, positions and roles came out of the grid as `m`, `german`, `outside, staff_only` and `["user", "vorstand"]` — on screen and in the Excel export. They now read the way they do everywhere else in the app.
- **Headings and labels are no longer shouted in capitals**, and the two VIS columns that showed up under an "Unmapped column" warning are now proper fields with an explanation of who writes them.

## v1.89.0 — 2026-08-14

### Type or paste a date instead of clicking through the calendar

- **Every date field in the app now takes typing and pasting.** Entering a birthdate meant paging a calendar back through twenty-odd years, one dropdown at a time; you can now just write `24.03.1998`, or paste it straight out of a spreadsheet or ClubDesk. The calendar button is still there and works exactly as before.
- **It reads the date the way you'd write it here.** `24.03.1998`, `24.3.98`, `24/03/1998`, `1998-03-24` and plain `24031998` all mean the same day. Day first, always — the same order the app shows dates in, so retyping what you see gives you back what you saw. On a phone, the digits-only form saves fighting the numeric keypad for a dot.
- **A date that does not exist is refused rather than quietly moved.** Typing `31.02.2026` outlines the field in red and changes nothing; before, that kind of input tended to become 3 March somewhere down the line. Unfinished typing is discarded when you click away, so a half-entered date never looks saved.
- **The calendar no longer jumps up and down as you page through months.** Months are four to six weeks long, and the popup used to resize with them — near the bottom of the screen that flipped it above the field and back again on the next month. It now keeps one height.

## v1.88.0 — 2026-08-14

### Membership fees are checked against the club's own rules

- **Data health now checks every member's fee against the rules the club actually follows: honorary members, board members and coaches pay nothing, passive members pay CHF 40, and everybody else pays what their category says.** It reports, it never changes an amount — a mismatch is as often a wrong category as a wrong amount, and that is a decision for the treasurer, not for software.
- **A team responsible is not a coach.** Coaches are free even when they also play; team responsibles pay their normal fee. Getting that distinction wrong would have reclassified four correctly-billed members.
- **Gap-year members are deliberately not judged yet** — whether a Zwischenjahr owes anything is an open question, and flagging 28 people on a guess would be noise, not a finding.
- **Members who owe nothing now get an invoice for CHF 0.** It shows the rate they would have paid and the waiver that cancels it, so the books have a record for every member instead of only the paying ones. These are filed, never emailed — nobody receives a bill for nothing.

### A fee category corrected here now reaches the member register

- **Changing somebody's fee category used to be undone again a few days later.** The category was owned by the register, so an edit here was never sent — and the nightly sync quietly restored the old value. It now travels to the register like the membership status does, and the amount travels with it, so the register can never end up saying "free" next to a CHF 440 bill.
- **A per-person amount set by the treasurer still wins.** Correcting a category is not permission to throw away a price somebody set by hand.
- **Fixes and corrections found by the same review:** seventeen basketball juniors who were billed as members while the register called them non-members are now members; six juniors left behind by the basketball fee increase have been raised; one member's category moved out of the bucket meant for people who have left the club.

## v1.87.1 — 2026-08-14

### Manually added games were missing from Home and Games

- **A game entered by hand in Spielplanung — or imported from the spreadsheet template — was stamped with the wrong season, and the season is what the home page, the games list and the website's fixture embed filter on.** The game saved correctly and showed on the calendar and in Spielplanung, so it looked entered; it was simply invisible in the three places most people actually look. Found on a Herren 2 basketball away game.
- **The season is now derived from the game's own date, in one place, so no entry route can stamp it differently.** The one affected fixture has been corrected.
- **The Spielplanung season picker no longer lists the same season twice** — the current season was written in a different format from the seasons on record, so it showed up as its own extra entry.

## v1.87.0 — 2026-08-13

### Set your own Kantonsschule

- **You can now set your Kantonsschule yourself, under Options → Profile. The signup form has always asked it, but only people who joined through the form ever had an answer on record — everyone else was blank, and there was no way to say so.**
- **“Nein” is a real answer, not a blank. It means you were asked and you are not at a Kantonsschule, which is different from nobody ever having asked.**
- **Only you and the club’s administrators see it — not other members, and not your coach.**

## v1.86.0 — 2026-08-13

### Which Kantonsschule a member attends

- **Members now have a Kantonsschule field. The signup form has always asked which Zurich Mittelschule an applicant attends, but the answer only ever lived on the application — invisible on the member, unfilterable and unexportable, and gone from view once the application was approved. It is now a field on the member, filled in for everybody whose application recorded one.**
- **Everyone else is blank, and that is the honest answer: most of the club joined before the form existed or came in through ClubDesk, so nobody has ever been asked. "Nein" is stored as a real answer and means asked and not at a Kantonsschule — different from blank.**
- **It is groupable in the grid, so "how many of ours are at KS Wiedikon" is one click. It can also be filled for many members at once with bulk edit.**
- **Section is now a dropdown instead of a free-text box. It only ever holds Volleyball, Basketball or KSCW, and those three are what decides which association fields you see and which section a member is administered under — a typo there did not fail, it quietly left somebody with no section at all.**
- **Pressing Enter in the search now banks whoever the search is showing and clears the box, so a selection can be built one name at a time without reaching for the mouse. The toolbar shows how many will be added before you press it.**

## v1.85.0 — 2026-08-13

### Assign coaches and team responsibles from the member

- **A member's page now has three team fields instead of one:** Teams (player), Teams (coach) and Teams (team responsible). Until now only the roster could be edited there — coaching and team-responsible links had to be set from each team's own page, so answering "which teams does this person actually run?" meant opening every team in turn. The old routes still work and write the same records.
- **They are deliberately three separate fields.** Putting somebody in as coach does not add them to the squad — a coach on the roster would appear in the team list, in attendance counts, in the table-duty pool and in the club register's player group as though they played. A player-coach is entered in both fields, which is what the club actually means.
- **The help text on the roster field used to say coaching links were edited in the table below it.** They were not — that table is read-only. It now points at the right place.
- **All three can be set for many members at once** from the bulk edit added in the last release, as add or remove only: replacing or clearing whole squads is not something a bulk action should offer.

## v1.84.0 — 2026-08-13

### Edit many members at once

- **The member grid can now select rows.** A tick box on every row and one in the header that takes everything currently listed. The selection survives changing the search or the filters, so you can search for one thing, tick a few, search for another, tick a few more, and act on all of them together — the count in the bar above the table is always the whole selection, not just the part you can see.
- **"Bulk edit" writes one or more datapoints to everybody selected.** You pick the datapoints the same way you pick them anywhere else in the explorer, and each one gets the same control the member's own page uses — a dropdown stays a dropdown, an IBAN is still checked. Roles and team memberships can be added to or removed from what each member already has, rather than replacing it: adding a role does not clear the roles somebody already held.
- **It tells you how many members it will actually change before you commit.** "9 of 12 members will be updated. 3 already hold every value." The three that already match are left alone entirely — no write, and nothing in their history to suggest anything happened.
- **Members are updated one at a time, and one failure does not lose the rest.** If a section administrator selects somebody outside their own section, that member is reported by name and the others still go through.
- **Fields where one shared value could never be right are not offered** — names, email, phone, birthdate, AHV number, IBAN, jersey number. Each says why. Data-protection consent is excluded too: it is the member's own declaration to make.
- **"Mark as departed" ends membership for a whole group in one step.** It sets the register status and the exit date and switches off club membership and app access together, because they are one decision — and asks once more, naming the number of people and the date, before it writes.

## v1.83.0 — 2026-08-13

### ClubDesk sync and Data health are now one page

- **The two admin pages have become one.** Data health used to report the ClubDesk problems as bare counts — "24 people are missing a group" — and then send you to a second page to find out who, while that second page had no idea what else was wrong. Both now live at Data health, and the counts have been replaced by the actual lists. The old address still works and takes you there.
- **The findings are split by section.** Tabs for volleyball, basketball, and everything club-wide, so the volleyball TK is not reading through basketball rosters to find their own. Members whose section cannot be worked out at all — no team, no volleyball or basketball fee category — get their own tab instead of quietly appearing under both sports, which is how they used to go unnoticed.
- **A new "Needs syncing" list.** Since the last sync, who is out of step with ClubDesk and why: not linked yet, link broken, left the club, waiting to be pushed, or a field that no longer matches. The times of the last sync down and sync up are shown next to it, and when the list is empty it says how many members are in sync — so an empty list reads as "everything is fine" rather than "the check did not run".
- **Each person's last invoice is shown next to the finding.** Particularly on the members who pay a playing fee but are on no team: you can now see whether they were actually billed, whether it is still open, and how much, without opening finance in another tab. "Never billed" is called out as its own answer.

### Fix ClubDesk groups from the app

- **The club's ClubDesk groups can now be corrected from Wiedisync.** ClubDesk has no interface for this that we can talk to, so until now a member missing their team's group had to be fixed by hand, one contact at a time. The new "Fix groups" button does it for you: it adds missing player and coach groups, and removes ones that contradict the current roster.
- **It always previews first.** The preview does every step except the final save, and shows you row by row what it would do. Only then can it be committed, and it asks once more before writing. This is the club's legal member register, so nothing about it is one-click.
- **It deliberately refuses the ambiguous cases.** Someone sitting in a team's group with no roster entry is usually a missing roster entry, not a wrong group — those stay on the list for a person to decide, marked as such. It only removes where the answer is unambiguous: the member has left the club, or they staff the team rather than play in it. It also never removes somebody's last group, and skips anyone it cannot identify with certainty rather than guessing at a name.

## v1.82.0 — 2026-08-13

### See at a glance which duty slots nobody has taken

- **The scorer assignment page has a new Overview tab.** It lists the season's duties one row per slot — which team is on it, and who from that team has signed up — so "is this game actually covered?" is answerable in one place, instead of from the assignment table and the scorer page together. It shows the duties as they stand today, not a plan that has not been rolled out yet.
- **One checkbox reduces it to the gaps.** "Only show empty spots" hides every slot somebody has already taken, leaving just the duties still to be filled, with a count above the list. Upcoming games are shown by default; past ones can be included when you want to look back over the season.
- **The list downloads as Excel exactly as shown, filter included** — a ready-made list to hand to a coach or paste into a message, with the open slots highlighted.

## v1.81.0 — 2026-08-13

### Transfers now cross-checks Swiss Volley's own records

- **The transfers page shows where Swiss Volley records a different federation of origin than we do.** This matters in both directions. For some players the club was preparing an international transfer that may not be needed at all, because Swiss Volley already counts them as Swiss. For others it is the other way round: our record says Switzerland and Swiss Volley's does not, and those are the ones nobody was chasing. Nothing is changed automatically — an administrator decides whether to correct our record or ask Swiss Volley to correct theirs.
- **Players who hold a club licence but are on no team roster no longer fall off the list.** They were counted in a footnote and worked by nobody. They now appear like anyone else, marked "Licensed, not on a roster", so the missing roster entry stays visible as something to fix rather than quietly disappearing.

## v1.80.2 — 2026-08-12

### Calendar subscriptions that had gone quiet work again

- **A subscribed calendar stopped receiving anything after the season changed.** If you added Wiedisync to your phone or computer calendar, the link pointed at your team as it existed that season — so once the club moved to the new season, the calendar kept working but never showed another training or game, with nothing to tell you. Existing links now follow your team into the new season on their own. You do not need to re-subscribe.

### Fixes you should not have to think about

- **People are no longer excluded from the duty lists by an old guest entry.** Being marked a guest on any team in any past season quietly removed someone from every scorer and scoreboard picker, and it never wore off.
- **Attendance percentages on a player's profile were showing 0%.** The statistics were being measured over a period that had not started yet, so nothing counted. They now cover the season so far, up to today.
- **Coaches and teammates only see people from current teams.** Access to teammates' absences and answers, and coaches' access to their players' details and their team's trainings and events, followed "was ever on a team with me" instead of "is on my team now". It is limited to current teams now; nobody loses access to anyone they currently play with or coach.
- **Several places disagreed about when a new season starts.** The team season dropdown switched over a month before everything else, so for all of May the current season was missing from it. Everything now uses the same date.

## v1.80.1 — 2026-08-12

### The J+S export was missing every participant

- **Jugend+Sport exports contained the leaders and nobody else.** The export asked for the season you picked but looked it up against this season's teams, and the two never matched — so every activity and attendance CSV came out with the coaches listed and not a single participant, with nothing on screen to say anything was wrong. Both now find the right season's squad. The activity lists were short for the same reason and are now complete. If an export ever does come back with no participants again, it says so instead of downloading quietly.

### Last season's teams stopped following people around

- **People were shown with teams they no longer play for.** A player who moved from D2 to D1 was listed as "D1, D2", because a team change adds the new team without ever putting the old one away. Team names now show the current season only. Which sport someone plays is still worked out from their whole history, so nobody disappears from a list because of this.
- **Coaches and teammates could still see people from past seasons.** Access to a teammate's absences and match responses, and a coach's access to their players' contact details, was granted by "has ever been on a team with me" rather than "is on my team now" — so it grew every season and never shrank. It is now limited to current teams. Nobody loses access to anyone they currently play with or coach.
- **A team change no longer briefly logs you out of your own teams.** For a day or so after the club rolled over to the new season, the app could think you had no teams at all — hiding the Yes/No buttons on trainings and games and emptying your team list until the rollover finished. Your teams are now read in a way that cannot fall into that gap.

## v1.80.0 — 2026-08-11

### Find one datapoint instead of hunting for it

- **Search for a field, not just a person.** The data explorer has a new Datapoint box next to the search. Type "AHV", "licence" or "Geburtsdatum" and pick the field you mean — the page then shows you that field and nothing else, for whichever member you open. It searches all ~110 columns by their English name, their German name and the database column, so "Lizenz" and "licence" both find the licence flags.
- **It works in the table too.** Focusing a datapoint pins it as a column right next to the name, so you can read it down the whole club at a glance. Your own saved columns are untouched — clear the focus and the table is exactly as you left it.
- **Empty fields still show up when you ask for them.** Searching for a field used to be pointless if the member had no value in it, because empty fields are hidden by default. A focused datapoint always appears, so you can see that it is empty — and fill it in.

### Sport admins can see their members' full record again

- **Birthdates and AHV numbers were being hidden from sport admins.** A privacy rule meant for members' profiles was also applied to the volleyball and basketball admins, so birthdates read as blank for almost every member and AHV numbers for all of them. Sport admins administer their sport's register and need both — for age categories, the scorer-licence surcharge and licence paperwork — so they now see those members' records as they are. The volleyball admin sees the volleyball section and the basketball admin the basketball one; each still sees the other section the way any member does. Members who belong to the club rather than to one sport stay visible to both. Coaches, team responsibles and everyone else are unchanged.

## v1.79.0 — 2026-08-11

### Invite people who are not in the club

- **An event can now have a public signup link.** Open an event, create the link, and anyone you send it to can sign up — no Wiedisync account, no app, nothing to install. They see the event, fill in their name, and they are on the list. Useful for a tournament, a Vereinsanlass, or bringing friends and family to something.
- **You stay in control of the link.** You can replace it, which makes the old one stop working immediately if it ends up somewhere you did not intend, or switch it off entirely. Turning it off keeps everyone who already signed up.
- **Guest signups appear alongside member ones.** The signups list shows members and guests together, so there is one place to see who is coming.
- **If you are logged in, the link takes you into the app instead.** Signing up as a guest would leave you off the team list, so members are sent to the event itself, where the normal Yes/No buttons count you properly.

### Also in this release

- **The event window reads more clearly.** The title now has its own line instead of being squeezed next to the buttons, the event type sits on its own row, and invited teams are listed as text rather than a wall of coloured tags.
- **Fewer things appearing after the page has loaded.** The home page used to reveal itself before the events section had arrived, and the games page before its team filter — both now wait, so the page appears complete in one go.

## v1.78.0 — 2026-08-11

### Share a link to any event, training or game

- **You can now send someone straight to an event.** Every event, training and game has a share button that copies a link opening that exact item in Wiedisync — so "you can sign up for this, here you go" is one message, instead of "open the app, go to Events, scroll down to Saturday". On a phone it opens your normal share sheet, so it goes straight into WhatsApp or a mail.
- **The link still works when you are not logged in.** Following one while signed out used to take you to the login screen and then dump you on the home page, with no idea what you had been sent. It now takes you to the login screen and straight on to the event.
- **Notifications open the thing they are about.** Tapping a notification used to leave you on the list page — often filtered so the item it was telling you about was not even on screen. It now opens the item itself.
- **A link only works for people who could already see it.** Sending a team's training link to somebody outside that team does nothing, and the link never gives away what it pointed at.

## v1.77.0 — 2026-08-10

### Security and privacy hardening

A platform-wide security review. Most of it you will never see — permission scopes, audit trails, guards on internal endpoints — but these parts affect you directly:

- **Your contact opt-out is now actually enforced.** If you had hidden your phone number or email address, the club's duty and scorer screens were still receiving them and simply choosing not to display them. The server now withholds them outright.
- **Nobody can look up a child's team from an email address.** Checking whether an address already has an account returned the team names attached to it — and team names carry an age (MU10, DU14). They are no longer returned for anyone under 18.
- **Logging out now clears your identity documents from the device.** If you had opened encrypted ID documents, the key and the documents stayed in the browser after logout. On a shared computer the next person could still open them. Logging out now wipes both.
- **Links in team pages are checked.** A waiting-list link on the website is now vetted before it becomes clickable.

### Fixed

- **"Absent on Mondays" showed on the wrong day abroad.** Weekly absences were matched against your device's calendar day, so travelling west of Switzerland shifted them by one.
- **A player profile could show 0/0 attendance.** One open-ended weekly absence removed every session from the count, so an actively training player's profile read 0/0 with dashes instead of percentages.
- **You can see your own fee category again.** Your profile showed a dash where your membership category should be — the field was never actually being sent to you. It is visible to you and to the treasurer, and to nobody else.
- **Invoices were missing their date, due date and breakdown.** Membership invoices went out without an invoice date, a payment deadline, an addressee on the payment slip, or the itemised lines — a surcharge showed only as one combined total.
- **News feed items had no date.** Every item in the website's RSS feed carried "Invalid Date".

## v1.76.1 — 2026-08-10

### Bug fixes

- **The last month-first date.** The member explorer's date columns — birthdate, Eintritt, Austritt — still opened the browser's own date box when you clicked one to edit it, the single place last version's date sweep missed. They now open the club's calendar and read **dd.mm.yyyy** like everywhere else.
- **Creating an event left the dialog open.** Saving a new event kept the dialog on screen, sometimes for minutes, because it waited for every invitation email to go out before closing — with the Save button already back to normal, so it looked like nothing had happened and invited a second click. It now saves the event, closes, and sends the invitations in the background: you get a note that they are on their way, and a warning if they fail.


## v1.76.0 — 2026-08-10

### Your licence status, on your profile

- **You can now see where your licence stands.** Your profile shows a licence status for the current season — *No licence*, *To be ordered*, *Ordered*, *Finalized* or *Licenced* — so "has my licence been sorted out?" has an answer you can look up instead of asking. It is read-only: the club sets it, and *Licenced* specifically means your federation confirmed it, not that somebody thinks it is done. If it looks wrong, tell your coach.
- **You are told when it changes.** Every move sends you a notification and a push, in your language.
- **It resets when the season turns over.** A licence is issued for one season, so on 1 June everyone starts again at *No licence* and is moved back up as the federation confirms this season's licences. Last season's green tick can never quietly stand in for this season's.
- **For admins: it is editable in two places.** The member explorer has it as a dropdown with its own filter — "show me everyone still to be ordered" is one click — and newly approved registrations carry the five states as buttons, right where you are already looking at the new member. Swiss Volley and Basketplan fill in *Licenced* automatically once they confirm a licence; they never overwrite the steps you set by hand.

### Dates are Swiss everywhere

- **A birthdate could read `05/10/2026`.** Date fields you type into — an applicant's birthdate on the registrations screen, and the basketball scheduling dates — were drawn by the browser, so anyone whose browser was set to English saw American month-first dates. That is worse than untidy: 05.10 and 10.05 are both real dates and nothing on the screen told you which one you were looking at. Every date field in the app now shows **dd.mm.yyyy** and opens the club's own calendar, whatever language you use it in.


## v1.75.1 — 2026-08-10

### Forgot password works again
- **"Forgot password" could not reset a password.** It sent you an 8-digit code, took the code, asked for a new password — and then said the link was invalid or expired. There was no link and nothing had expired: the code path is only able to set a *first* password, so for anyone who already had one it refused at the last step, and the message named the wrong cause. People read it as a broken email and requested code after code. Forgot password now emails you a **reset link** instead, which works whether or not you have a password already. If you have never set one, "Use a code instead" is one click below.
- **The "Reset password" button on your own profile said it had failed.** It reported an error every time even though the email had already been sent — so the mail arrived while the screen said it had not.
- **Resetting while still signed in changed the wrong account.** If you were already logged in on that browser, opening a reset link set the password of *the account that was signed in* and quietly ignored the link — so on a shared computer, following someone else's reset email changed your own password instead of theirs. The app then kept running on a login that had just been invalidated, so the next page filled with errors until you signed in again. A reset now always acts on the account the link or the code names, and signs the browser out cleanly when it is done.

## v1.75.0 — 2026-08-10

### A member's fee, in one place
- **The membership fee category moved to Finance & billing, and brought the amount with it.** The category used to sit under Membership on its own, naming a rate but never the money — "why is this member billed CHF 310?" meant knowing the club's fee table, the CHF 100 scorer-licence rule and the age cut-off by heart. Finance & billing now shows the **Beitrag amount** right under the category, itemised: the base, the scorer-licence surcharge, the guest reduction and any discount, adding up to the total, and it says whether the base came from this season's rate table or the fallback list.
- **A fee can now be set for one person without touching anybody else.** Three fields — base, scorer-licence surcharge and discount, plus the wording that appears on the invoice — take a value for that member only. Leave them empty and the fee is worked out exactly as before; enter one and it is used everywhere the club bills, both the invoice run and the club register. Waiving the CHF 100 surcharge, which used to be done by writing the amount off after the invoice had already gone out, is now entering a 0.
- **Nobody's fee changed.** Every member starts with no override, so every amount is the same as it was until somebody types one.
- **PDF previews were blocked on the live site.** Registration documents, form uploads, receipts, mailbox attachments and ID scans all opened as an empty box — the browser was refusing to display them. Fixed; pictures were never affected, which is why it looked like a PDF problem.

## v1.74.0 — 2026-08-10

### The member explorer opens on what matters
- **A member record no longer opens as 95 field cards.** Fields with nothing in them, and the machine-owned ones — audit stamps, sync bookkeeping, encryption keys — are now hidden to start with, so a record opens on roughly half as many. Two buttons in the header bring either set back whenever you need it, and your choice is remembered. Editing always shows the blank fields again, so nothing ever becomes impossible to fill in.
- **The "Nationality (ClubDesk spelling)" field showed the wrong spelling.** It is there to show the exact word written into the club register — "Schweiz" — but it was being translated into the language of whoever was looking, so an English session read "Switzerland" and there was no way to see what the register would actually receive. It now shows the real value.

## v1.73.0 — 2026-08-10

### Documents open where you are
- **A PDF now opens inside the app instead of sending you somewhere else.** Registration documents, invoice attachments, expense receipts, form uploads and mailbox attachments used to hand you a new browser tab — or, for receipts and mail attachments, drop a file into your Downloads folder — just so you could read them. They now open in a window over the page, with the document itself on screen. Opening in a new tab and downloading are both still one click away.
- **Photos and PDFs behave the same way.** Whatever was uploaded, the same window shows it, so there is no longer a rule to remember about which kind of file previews and which kind does not.
- **An ID saved as a PDF could not be viewed at all.** Both the identity document on your own profile and the ID deck a coach opens at the match table only ever tried to show a picture, so a member who had uploaded a PDF scan showed a broken image to themselves and to the referee. Those now open properly.

## v1.72.0 — 2026-08-08

### Mixed teams can take girls and boys separately
- **A mixed team fills up per gender, and "open for new players" could not say so.** U8 and U10 are mixed, but the squad has room for girls and not boys, or the other way round — and the single switch either invited everyone or nobody. Mixed teams now have **two more switches under it**, one per gender.
- **The club website acts on them.** With only one of the two on, the team's card on the Nachwuchs page splits in half: the gender being taken gets the green badge and the contact form, the other gets the "Team voll" badge and the waiting list. Turning both on — or leaving both off, which is where every team starts — shows the single "open for new players" row exactly as before, so nothing changes until a coach opts in.
- Only mixed teams see the switches; a girls' or boys' team is unaffected.

## v1.71.0 — 2026-08-06

### The member data explorer, rebuilt
- **Every field now has a real name and a real home.** The explorer showed the raw database column name for anything it had not been taught about, and dropped those fields into an unnamed pile at the bottom. All 100 fields of a member record are now labelled in plain language and grouped by what they are for — identity, contact, membership, playing and coaching, association admin, roles, finance, privacy, notifications, ClubDesk, transfer, and the machine-owned ones last.
- **Fields you cannot edit now say why.** A locked field used to give no reason, so the only way to find out was to ask. Each one now names what writes it — a Swiss Volley or Basketplan sync, a database rule, or the app itself — so it is clear whether the value is wrong or simply not yours to change here.
- **The right keyboard for the right field.** A phone number is entered with a country prefix picker and is tidied into the club's standard format as you leave the field; an AHV number gets its dots and is checked; postal code and jersey number open a number pad; a profile photo is picked and previewed rather than typed as a code; a team is chosen from a searchable list rather than by its ID.
- **Only the sport the member actually plays is shown.** Licence and official fields for both sports were shown to everyone, so half of them were never relevant. The explorer now works out the member's sport from their teams — including coaches, who have no roster entry — and hides the other sport behind a toggle in case you need it.
- **Association admin is one place.** Swiss Volley and Basketplan details now sit together under one heading instead of the old "Address & Swiss Volley admin" grouping, which had no room for basketball at all.
- **Teams can be changed from the member's page.** A member's teams were read-only here and had to be edited elsewhere; they are now a multi-select on the record itself.
- **Secrets are never shown.** Encryption keys and calendar tokens now read only as "Set" or "Not set" — the value itself is no longer sent to the page.

### Club mailbox: merge fields you can see working
- **A recognised field turns blue as you type it.** `{{first_name}}` in the message body is now highlighted the moment it is recognised, so there is no doubt left about whether it will be replaced or sent to 117 people exactly as written. The subject line, which cannot colour its own text, lists its fields underneath instead.
- **A field that is not recognised is struck through in red**, and named again under the editor. This is the case that actually bites: `{{firstname}}` without the underscore is not a field, and until now nothing said so — it simply arrived in the inbox as `{{firstname}}`.

### Removing a member, safely
- **Membership and app access can be switched off from the member's page**, separately — someone can stop being a member while keeping their login, or the other way round.
- **A record can now be deleted outright, and the app shows you what goes with it first.** Before anything happens you get a list of everything attached — attendances, absences, fines, invoices, team entries, the login — separated into what will be deleted along with it and what will block the deletion until it is dealt with. Only then, after typing DELETE, does it go ahead.
- **The same applies to events, trainings and games.**
- **Deleting a member now also removes their login**, which previously stayed behind and could still sign in.
- **You cannot delete yourself**, and only a full administrator can remove another administrator or a board member. A section administrator can only remove people in their own sport.

## v1.70.0 — 2026-08-06

### Club mailbox: paste a list of addresses
- **Recipients are now chips.** Paste a whole column of addresses into To, Cc or Bcc and each one becomes its own removable chip — one per line, per comma or per semicolon, so a list copied out of a spreadsheet or another mail client no longer has to be tidied up by hand first.
- **Addresses that carry a name are read correctly.** `Anna Muster <anna@example.ch>` was previously discarded without a word: the send only ever accepted a bare address, so a recipient pasted in that form silently never received the mail. The name is now stripped off and the address kept.
- **An address that cannot be read is shown in red and blocks the send** instead of being dropped on the way out. Duplicates are merged, so the same person pasted twice gets one copy.
- Enter, Tab, comma and semicolon finish the address you are typing; Backspace on an empty field takes the last chip back for editing.
- **The group send takes a pasted list too.** "Email a group" could only reach an audience the app already knows — a team, a role, a season. A hand-curated list out of a spreadsheet is none of those, and the only way to mail one was to expand a large audience and delete everyone else. You can now paste the addresses straight in: each is matched to the person behind it, and the send treats them exactly like any other audience — one message each rather than one message with everyone's address in the header, with names filled in and anyone who has unsubscribed left out. It tells you before you send how many were recognised and names the ones that were not.
- **Recipients are listed by surname, and you choose where a pasted list goes.** A pasted column arrives in whatever order the spreadsheet had it, which is not an order you can check against the club register — the names now sort by surname, and anyone we only hold an address for is shown as that address, grouped at the end where they are easy to spot. When you paste, you pick whether the list becomes recipients (one message each, names filled in, unsubscribed members left out) or a Cc / Bcc copy (one shared message, and the app now says so and stops you before an oversized copy is refused by the mail service).
- **More merge fields, and a preview of what each person will actually receive.** Besides the first and last name you can now drop the full name, email address, fee category, membership fee and team into the subject or the body — and the English field names ({{first_name}}, {{fee_amount}} …) always worked, but the tip only ever showed the German ones, so in an English app the feature looked German-only. A new Preview button renders the message as three real recipients would receive it, and warns when a field would come out blank for some of them — so a sentence like “your fee is CHF …” cannot go out with a hole in it for the members nobody has priced yet.

### Email wording is now yours to change
- **The text of the emails the club sends to people who register can be edited in the app**, under Email templates. Until now every word lived in the code and changing one meant a deployment, so the wording was effectively frozen and out of reach of the people who actually write to parents.
- **Each language is edited separately**, and a preview shows the message exactly as the recipient will see it — including changes you have not saved yet.
- **Emptying a box puts the original wording back** rather than sending an email with a gap in it, and the message cannot be saved without the part that lists the missing documents. A mistake in an email that goes to families should not be possible to save, let alone send.
- **A new Sent tab keeps every email the club has sent from a template**, exactly as it was received. Because the wording can now change, reading today's template would no longer tell you what someone was actually told in August.
- **Replies now reach the club.** The emails are sent from a no-reply address while the text invited people to reply, so an answer went nowhere; replies are now directed to kontakt@kscw.ch.

## v1.69.0 — 2026-08-06

### Registrations: asking for documents we lost
- **An approved registration can now be asked for its missing documents.** Two upload faults in July destroyed or never stored the Swiss Basketball paperwork for seven registrations, and the families had no way of knowing — the registration looked approved and finished from their side.
- **The request does not reopen the registration.** The person stays a member, keeps their team and their ClubDesk entry; only the documents are asked for. Reopening would have re-run the whole approval — a second welcome email, a second ClubDesk contact — for something that was never their mistake.
- **The email lists only what is actually missing**, in the language the person registered in, and the link it carries already knows who they are. A Swiss junior is asked for three documents, a foreign one for five, and someone who only lacks the two declarations is asked for two.
- **Documents already on file cannot be overwritten** by the upload page, so a re-send can never quietly replace something that was already checked.

## v1.68.0 — 2026-08-05

### Basketball scheduling
- **Spielplaner can now open the basketball scheduling pages.** The volleyball routes have always let a Spielplaner in; the basketball ones only ever accepted a basketball admin, so anyone given the Spielplaner role found the link simply did not work — and it then sent them to the volleyball planner instead of saying why. It now says why.
- **A team's available dates now cover its own season.** Every team was being offered the junior schedule, which ends on 13.12.2026 — so the two teams that play into May were declaring barely a third of the weekends the association asks about. The autumn and spring closures, Sport and Easter holidays included, are in as well.
- **Dates where the halls are taken no longer show up blank.** A Saturday with volleyball in all three halls rendered as an empty box with no explanation; it now names the reason — volleyball, a hall closure, a holiday or a club blackout.
- **A volleyball match in the afternoon no longer blocks the whole day.** Occupancy is worked out by the hour, so an evening basketball game in the same hall is offered normally, with the changeover time between the two respected.
- **The calendar is on the planning page itself**, since away games can be placed almost anywhere and the two are read together.
- **Each team can carry its own rules** — preferred start time, which days, which hall, who it must not clash with and who it should play alongside — and the planner proposes dates from them, showing why each one ranks where it does.
- **Opponent clubs can be sent their own link**, one per club, where they see our available dates and reply. The same idea as the volleyball opponent links, adapted to how basketball is scheduled.

## v1.67.0 — 2026-08-05

### Hall finder: export to Excel
- **A search result can now be taken away as a spreadsheet.** The table shows four of nineteen fields on a phone — the address, postcode, district, quarter, school district and caretaker contact are all hidden, and those are exactly what you need to actually chase a hall. The export carries every field, one row per hall.
- **Hall dimensions come through as numbers**, not just as the city's "45,00 x 27,00 x 7,00 m" text, so you can sort or filter by length and find the halls that fit a full court.
- **The search itself travels with the file** — the weekdays, time, minimum duration and district you searched for, the season, and the date the availability data is from. A list of "free halls" with no filter and no date is one nobody can act on a fortnight later.

### International transfers: checking the FIVB index when you need it
- **"Check VIS now" asks FIVB there and then.** The check used to run once a month, so for thirty days out of thirty-one the page showed a fixed answer and the Refresh button could only reload it — which read as though Refresh were broken. It now also runs automatically every week rather than monthly.
- **The page says how old the VIS numbers are**, and the two buttons now explain which one re-reads our own data and which one goes and asks FIVB.
- **A player already in the index is no longer reported as missing because of her name.** Where a middle name or a compound surname sat on the other side of the first-name/surname split, the match failed and the player looked absent from a register she was in all along.

## v1.66.0 — 2026-08-05

### Coaching qualifications and officials' licences
- **Basketball coaches can now record their qualification.** The profile only offered the volleyball ladder (Trainer C / B / A), so a Trainer 1 or Trainer 2 had nothing to select and the club's register kept the answer to itself. The list now shows the rungs for your own sport, with J+S available to everyone.
- **Three referees were missing their licence in Wiedisync.** Their names are spelled slightly differently in Basketplan, so the nightly import had never matched them and they were absent from the officials list despite holding a current licence. Their licence numbers are now on file, which is what stops it happening again.

## v1.65.0 — 2026-08-05

### Fixed: setting a new password
- **Choosing a new password works again.** The form accepted any password of 8 characters or more, but the server also requires a number or a symbol — so a password made only of letters was rejected *after* you pressed save, and the app blamed the reset link instead of the password. At least one member spent a quarter of an hour requesting fresh links to fix a link that was never broken.
- **The rules are now written under the password field**, and if a password is turned down the app says which rule it missed, in your language.
- **The "Set password" link in the reset email now opens the password form.** Until now it landed you back at the code-by-email screen, so the mail was effectively a dead end.
- **A clearer answer when the address is not on file.** If we cannot find an account for the address you typed, the app now suggests trying the address the club has on file for you. Members whose personal address differs from their club one were told no account existed and pointed at signing up, which would have created a duplicate.

## v1.64.0 — 2026-08-04

### Club emails: picking who gets them
- **Picking two teams now means both of them.** Choosing D1 and D2 used to ask for the people who are on *both* rosters — almost nobody — so a mail meant for 39 players would have reached a handful. Anything picked from the same row is now added together, while picking across rows still narrows: **Volleyball** plus **Coaches** is still the volleyball coaches.
- **Every option shows what it would make the audience, live.** Choose Volleyball and the Coaches count drops from 30 to 15 in front of you, so you can see what a filter costs before committing to it.
- **Write to members by type** — active, passive, honorary, gap year — **or to guest players**, alongside the existing "all members".
- **Scorers, referees and officials now mean the people who actually do the job for the club**, taken from the ClubDesk groups, rather than everyone who happens to hold the licence. The basketball officials list alone was 31 people too broad.
- **The composer opens on the current season**, and the season sits next to the options it applies to.

## v1.63.3 — 2026-08-04

### Fixed: seeing who has answered a game
- **Coaches, team responsibles and admins can reach a game's attendance list again.** For them the roster button opened the match sheet and nothing else, so the people most likely to ask who has replied had no way to see it from the game. There are now two buttons — **Match sheet** and **View roster** — and the first one finally says what it does. Everyone else still has the single button, unchanged.

## v1.63.2 — 2026-08-04

### Fixed: saying whether you are coming to a game
- **Players called up from another team can now answer.** Opening a game to another team put the fixture on all their calendars but gave them no Yes / Maybe / No buttons, so nobody could actually say whether they were coming. Their replies now count towards the game's tally like everyone else's.
- **The Yes / Maybe / No buttons are back on the games list.** Since 10.06 they only appeared once you opened a game, so answering straight from the list was impossible. The same fault also meant a coach's reply was counted as a player's instead of being filed under staff, and that players who may not play league games were not held back.
- **Attendance counts appear together with the rest of a game**, instead of a moment later, and no longer nudge everything below them as they arrive.

## v1.63.1 — 2026-08-04

### Fixed: uploading your ID from a phone
- **Uploading an identity document works again.** Tapping "Upload document" opened the camera or photo library but then bounced you back to your profile, and the photo you took was silently discarded — nothing was saved and no error was shown. Every attempt since 28.07 failed this way.
- **You can now crop and rotate the photo before it is saved.** A phone shot of an ID is usually sideways, or a small card on a big table; you can straighten it, zoom in and trim away the background, with presets for an ID card, landscape or portrait. As before, the picture is encrypted on your own device — the club still cannot read it, and now only the part you kept is stored at all.

## v1.63.0 — 2026-08-03

### Improved: choosing who a club email goes to
- **Audiences are clickable chips** showing how many people each one reaches, instead of a dropdown you had to open to see what existed.
- **You can combine them** — pick "All coaches" and two teams and it goes out once to everyone, with nobody receiving it twice.
- **Sections and teams are separate choices.** "Volleyball section" reaches everyone in the section including coaches and staff; "Volleyball players" reaches only those on a team right now.
- **Former members can be reached** too, for the rare club-wide announcement that warrants it.
- **Bounced addresses and spam complaints are remembered and skipped automatically**, which protects delivery of everything else the club sends — including password reset emails.

## v1.62.0 — 2026-08-03

### New: the club can email a whole group at once
- **The club mailbox can now write to a whole group** — a team, all coaches, all scorers, all referees, the board, or every member — instead of pasting addresses together by hand.
- **You see who it reaches before you send.** The recipient count is resolved up front, along with why anyone is left out (no address on file, unsubscribed, or sharing an address with someone already on the list).
- **Everyone gets their own copy**, so nobody sees anyone else's address, and replies come back to the club mailbox where the whole board can follow them. Attachments are supported, and `{{vorname}}` greets each person by name.
- **Group emails now reach members who have never signed in.** Previously a message to "all scorers" quietly went to only about two thirds of them, and to "all basketball referees" to barely a quarter.

## v1.61.0 — 2026-08-03

### Improved: the live scoreboard page
- **The hall scoreboard now actually feeds the page.** The board publishes every score change itself, so Live shows a real match without anyone doing anything — for volleyball, beach volleyball and basketball alike.
- **A final screen when the match ends**, naming the winner and the result, above the full board.
- **Recent matches on the scoreboard** are listed underneath, so the page is still worth opening once a match has finished.
- **A "live now" link on the games page** while a match is being scored, so you don't have to go looking for it.
- Small touch: the score gives a brief bump when a point lands (skipped if you've asked your device to reduce motion).

## v1.60.0 — 2026-08-03

### New: follow a match live from the scoreboard
- **The hall's scoreboard now feeds a live page in the app.** Open **Live** and you see the same score the LED board in the hall is showing, updating on its own every few seconds — no refreshing, and no need to be logged in, so you can share the link with family and friends.
- **It works for volleyball, beach volleyball and basketball.** Volleyball shows the points in the current set, sets won, timeouts, substitutions, who is serving and the scores of the sets already played; beach shows both players of a pair; basketball shows the running score, the quarter, team fouls with the bonus and the possession arrow.
- **The page tells you what it is doing** — whether it is live, finished, or waiting for a match to start.

## v1.59.0 — 2026-08-01

### New: call up players from another team for a single game
- **A coach can now open one game to another team, or to individual players.** A cup game filed under H1 can be opened to H3; a junior can be pulled up for one Saturday. The called-up players see the fixture on their home page, in their calendar and in their subscribed calendar file, and they answer yes/no/maybe there like any other game.
- **They appear in the participation list with everyone else**, marked with the team they were called up from, so the coach picks a squad from one list instead of two. Their jersey number for that game is set on the match sheet as usual, and they are carried onto the Volleymanager nomination list.
- **Nothing about their team membership changes.** The call-up is scoped to that one fixture: their trainings, absences, attendance figures and ClubDesk group are untouched, and it disappears when the game does.
- **They get a notification** when they are called up, and their reminders — the answer deadline and the "game tomorrow" nudge — work exactly as for the home team. If they mark themselves absent that day, their answer is withdrawn automatically.
- **The coach is warned about clashes**, not blocked: anyone already playing a game that day is flagged in the picker and in the summary, and the two coaches decide.
- Only the coach or team responsible **of the game's own team** can call players up, and closing a team call-up releases the players it brought while keeping anyone invited by name.

## v1.58.0 — 2026-08-01

### Fixed: cancelled trainings and games looked like they were still on
- **A cancelled training now shows as cancelled on the calendar** — struck through and dimmed, instead of looking exactly like one that is still happening. This was most confusing on a game day: the club automatically cancels a team's training when that team plays that evening, so the training was correctly called off in the system but the calendar still advertised it right next to the fixture. Opening it explains why ("Cancelled — game day"). The same applies to cancelled games and events, in every calendar view and in the "Next 7 days" strip on the home page.
- **Exported calendar files (.ics) mark cancelled entries too**, so they are also clear in Apple Calendar, Google Calendar and Outlook. The subscription link already did this.
- **The home page no longer jumps while it loads.** The "Next 7 days" strip appeared a moment after everything else and pushed the rest of the page down as it arrived; it now holds its place from the start.

## v1.57.0 — 2026-08-01

### New: hall sizes and photos in the hall finder
- **Every hall in the hall finder now shows its size** — length, width and ceiling height, exactly as the city publishes it. All 104 halls have one, so it is finally possible to tell a full-size sport hall from a small gymnastics room without opening the city website for each.
- **A photo of the hall** where the city has one on file (about half of them). Tap it to see it full size.

## v1.56.2 — 2026-07-30

### Improved: participation exports (PDF, image and CSV)
- **Staff and waitlisted players no longer vanish from a filtered export.** Exporting with a status filter on (e.g. "Confirmed") dropped every coach, team responsible and waitlisted player from the sheet, even though they were still listed on screen. The export now matches what the participation list shows; the filter narrows the roster only.
- **The export header names the activity again.** Opening the participation list from the events or trainings list produced a sheet headed "Participation" with nothing identifying it; it now carries the event or team name and date, in the header and in the file name.
- **One guest column instead of two.** "Guest" (is this a guest player) sat next to "Guests" (plus-ones) and read as a duplicate. A guest player is now marked in the name — like the coach, captain and team-responsible markers — and the remaining column is only about plus-ones.
- **A Team column when the list covers several teams**, with the rows grouped by team. Single-team lists are unchanged.

## v1.56.0 — 2026-07-30

### Fixed: coaches' answers on a multi-day event went missing
- **A coach or team responsible who is not on the team's player list could answer a multi-day event** (the Trainingsweekend), **and their answer was filed as a player's.** The participation list showed them as "Not responded" while the count on the card treated them as one more player coming. Their answers now appear where they belong, and the "Coach present" figure counts people rather than days — a coach who said yes to both weekend days counted twice.
- **On an event that invites several teams, only the first team was considered** when deciding whether you answer as staff or as a player. A coach of the second team was filed as a player.

### New: answer for the staff too
- **Coaches and team responsibles now have the same edit controls as everyone else in the participation list** — including the "all days at once" answer on a multi-day event's Overall tab, per-day answers, and notes.

### Fixed: rows cut in half in the PDF export
- **Exporting a participation list longer than one page split the last row of every page across the page break** — the name on one page, the answer on the next. Pages now end between rows.

## v1.55.0 — 2026-07-29

### New: answer for every day at once on a multi-day event
- **The "Overall" tab of a multi-day event's participation list is now editable.** Setting a member to Yes / Maybe / No there applies it to **every day at once**, instead of opening each day's tab and repeating the same answer. Days that already disagree are brought in line; a member whose days genuinely differ starts from a blank dropdown rather than a guess, and their per-day notes are left alone unless you actually type one.

## v1.54.2 — 2026-07-29

### Fixed: day-by-day answers on a multi-day event didn't stick
- **Setting a member's answer for a single day of a multi-day event** (the Trainingsweekend and anything else with per-day responses) **saved to nowhere** — the roster kept showing "Not responded", and a second attempt failed with an error mentioning that a value "has to be unique". Answers now save to the day you picked.

## v1.54.1 — 2026-07-29

### Fixed: saving an edit failed with a "has to be unique" error
- **Editing an existing event, form, hall slot or team's staff could fail to save**, with an error mentioning that a value "has to be unique" — even when you had only changed something ordinary like a response deadline and hadn't touched the teams at all. Everything saves again.

## v1.54.0 — 2026-07-28

### New: identity documents are watermarked when shown
- **Every identity document displayed before a game now carries a visible stamp burned into the image itself** — club, purpose ("Spielkontrolle / match check"), who opened it and when. A screenshot or photo of the screen keeps the stamp, so the document cannot pass as a clean copy anywhere else, and any leaked image is traceable to the (already audit-logged) viewing.

### Improved: showing IDs before a game
- **One tap instead of two**: "Show IDs" now downloads the documents by itself if you haven't pre-downloaded them. The separate "Download for offline" button remains for preparing before you travel — halls often have no signal.
- **The dialog comes alive on time**: if you open it before the 45-minute window, the Show button now unlocks itself the moment the window opens (and closes itself at kickoff) — no more closing and reopening.

### Changed: your identity document is managed in Edit profile
- The encrypted identity-document section moved from the profile view to **Edit profile**, next to the other things you can change — and it now loads in one piece instead of flickering through loading states.

## v1.53.0 — 2026-07-28

### New: complete your profile to use the app
- **The app now asks for your core contact details before you can continue**: phone number, birthdate, address and nationality. The club is required to keep these in the member register, and until now coaches and staff were never asked for them at all. If your profile already has them (most members), you won't notice anything.
- **Coaches and staff without a playing role are now recorded in the "Gratis" fee category automatically**, so they appear correctly in the club register instead of with no category at all.

## v1.52.0 — 2026-07-28

### Improved: game days no longer show a training your team can't attend
- **Trainings on game days are cancelled automatically.** When your team has a game — home or away — that day's training is taken off the calendar instead of sitting there contradicting the game. If the game moves or is called off, the training comes back by itself. A coach can still reinstate a training ("we practice before the game"), and that decision sticks.
- **Players in two teams are excused automatically.** If your other team has a game that day, you are signed out of the training with a note naming the game (e.g. "Game H2"). Your own answers always win: if you explicitly said you'll attend the training, or you declined the game, nothing is changed — and any manual change you make afterwards is never overridden.

## v1.51.0 — 2026-07-27

### Improved: the app now speaks French and Italian throughout
- **Nearly a thousand interface texts per language were still English for French and Italian users** — the whole finance area, most of the member admin, the forms feature, the hall finder, the game-scheduling tools and many smaller corners. All of them are now properly translated, using the same club vocabulary as the existing translations (marqueur/segnapunti, cotisation/quota, créneau/fascia …).
- **Swiss terms where they belong**: J+S becomes Jeunesse+Sport with its official Moniteurs/Monitori, city districts render as arrondissements/distretti, and accounting screens use proper Swiss bookkeeping vocabulary in both languages.

## v1.50.0 — 2026-07-27

### Removed: three unused features
- **Per-activity task checklists, game carpools and the admin saved-queries strip have been removed.** None of them saw a single use across a full season, and each carried real maintenance weight. The fines page, hall-slot claims and referee expenses stay — they are expected to earn their keep when the 2026/27 season starts.

## v1.49.0 — 2026-07-27

### Fixed: club-wide events were missing from the website and calendar feeds
- **Club-wide events — those open to everyone rather than tied to a team — had disappeared** from kscw.ch and from subscribed calendars. They are back, and the underlying data problem can no longer recur.
- **Cancelled events now disappear properly**: the website no longer lists them, and subscribed calendars receive a cancellation so they vanish there too.

### Fixed: a cancelled game stayed cancelled
- A game cancelled in the app was **silently put back on the calendar by the nightly league sync**. A cancellation now sticks unless the league reports the game as played — and if a game genuinely is back on, everyone on the team gets a **"Game back on"** notification instead of it quietly reappearing.

### Fixed: attendance counts and absence sign-out
- Duplicate RSVPs could double-count members in attendance tallies, and RSVPs left over from deleted trainings inflated per-member statistics. Both are cleaned up and can no longer recur.
- **An absence now also signs you out of club-wide events and events you were personally invited to** — previously you could even be auto-signed-*in* while absent. Multi-day events are declined per day, matching how you sign up for them.

### Improved: member admin and data integrity
- The member admin form is now organized into **collapsible sections** (identity, address, licences, preferences, billing, …) instead of one flat 100-field list.
- The admin **"Last online"** column now actually shows when a member last logged in.
- A broad round of database hardening: proper cross-references throughout games, trainings, rosters and finance data, duplicate records merged, and faster admin audit pages.

## v1.48.0 — 2026-07-25

### New: Hall finder — free city sport halls for the season
- **A new admin tool (Options → Hall finder)** shows which City of Zürich sport halls have a free recurring training slot for the whole winter season, so you no longer have to check the city booking site hall by hall.
- **Filter by weekday, earliest start, minimum duration, city district and hall type.** By default it lists only halls that are free every week excluding school holidays; switch that off to also see halls that are free most weeks.
- **Each result links straight to the city occupancy calendar and to a pre-filled reservation request.** Availability is refreshed automatically every night.

## v1.47.0 — 2026-07-25

### New: nationality is now a proper list, with flags
- **Pick every nationality you hold, not just one.** The profile nationality field is a searchable list with flags — start typing a country or its two-letter code. Dual nationals can select both; the first one you pick is treated as your main one and is what the club register receives.
- **It reads in your language.** Previously the field held a German country name whatever language you used the app in.

### New: federation of origin
- **A new profile field asks which national federation licensed you at age 14** — the definition Swiss Volley and the FIVB use, and the one that decides whether an international transfer is needed to play here. It is not necessarily where you first played.
- **"None" is a real answer.** If no national federation licensed you at 14 — for example if you only ever played recreational leagues such as Italy's CSI, UISP or PGS, which are not FIVB or FIBA members — choose it. That tells the club there is nothing to request, which a blank field cannot.
- The membership sign-up form asks the same two questions, so new members arrive with the answer already recorded.

### New: Transfers page (club staff)
- **A per-sport view of international transfers**, grouped by federation of origin, with a note field and a done marker. It also lists members whose nationality suggests the question has never been put to them.
- **For volleyball it cross-checks Swiss Volley's licence data and flags two situations**: someone marked done whose licence is not validated — meaning they are not yet eligible to play — and someone still marked pending whose licence has been validated, which usually means the certificate has already arrived.
- **One prepared email per federation.** A transfer cannot be requested until the player exists in the FIVB VIS index, so each federation group carries a single ready-to-send request listing everyone of theirs still missing from it, with name, date of birth and email. Copy it, or open it straight in your mail programme. It is always written in English — the working language of the FIVB — whatever language you read the app in.
- **The federation's own contact address is on file** for every country our members come from, taken from VIS, and shown once per group.
- **Only members who are actually on a team appear.** Anyone on no team is counted in the page header instead of filling the lists; add them to a team and they return.

### Improved: officials licences distinguish OTN 1 and OTN 2
- **The basketball table-official licence now records the level**, matching Swiss Basketball's own register, which has always kept the two apart.

## v1.46.1 — 2026-07-25

### Fix: open-ended absences now sign you out reliably
- **An absence with no end date now signs you out of every training and game across its whole span** — including sessions added to the calendar later — just like a dated absence does. Some open-ended absences (typically the long-term ones entered on a member's behalf) were being missed, so the person still showed as attending. This is independent of the "blocks game scheduling" switch, which only affects planning and never changes your own attendance.

## v1.46.0 — 2026-07-16

### New: send club news to specific teams or roles
- **Club news can now be addressed to particular teams, or to people by what they do.** Alongside "all members" and "one sport", you can pick specific teams — which reaches their players, coaches, team responsibles and captain — or target roles and functions: the board, coaches, captains, scorers, referees, finance, and so on. The email, the push and the in-app post all go to exactly that group, and nobody else sees the post.
- **Every news email now asks you to confirm before it sends**, and tells you who it is about to reach. Previously only the "all members" blast asked.

## v1.45.0 — 2026-07-15

### New: guided tours for more of the app
- **The in-app guide now covers more areas.** News, Fines, and the Calendar each have a short, tap-through walkthrough that points out the buttons and lists right on the page. Open Guide from the menu and pick a tour — a green tick marks the ones you have finished.

## v1.44.0 — 2026-07-15

### New: go by the name you actually use
- **You can set a preferred display name in your profile.** If people call you something other than your legal first name — Honza instead of Jan, Thamy instead of Thamalayant — set it once and the whole app shows it: rosters, RSVP lists, chat, absences, scheduling. Leave it empty to keep your first name.
- **Official documents are unaffected.** Match sheets, Volleymanager, ClubDesk, invoices and the public website always use your legal name — only the in-app display changes.

### New: basketball scheduling prep (for coordinators)
- **The scheduling app now has a Volleyball / Basketball toggle.** Basketball follows a completely different process from volleyball — the association (ProBasket) builds the schedule at a central planning meeting — so its section is a preparation view: for each team it shows which home dates (Fri/Sat/Sun) the KWI hall is free, with volleyball's hall use, closures and blocked dates overlaid, and lets you record availability to bring to the meeting or the 17 August hall-availability form.

## v1.43.0 — 2026-07-14

### New: the match sheet, on your phone
- **Coaches and team responsibles can now open the match sheet from a game**, in the hours around kickoff, and hand the phone to the scorer. It is laid out the way the sheet is actually filled in: birthdate, number, then surname and first initial. The captain's number is circled, liberos appear again in their own block, and the officials are listed at the bottom.
- **You can adjust it for that one game.** Change a number, move the captain's circle, flag a libero, or — in an emergency — add a player who turned up unnominated or strike out one who did not. None of this touches the player's normal shirt number, position, or the team's captain: it applies to that match only.
- **Adding or removing a player is the only change that can disagree with Volleymanager**, and it is the only one that raises a warning. Numbers, captain and libero do not exist on the Einsatzliste at all, so changing them cannot contradict it. If you do add or drop someone, Wiedisync tells you, in red, that the same change must also be made by hand in Volleymanager — it does not send it for you.

### New: your ID, encrypted so that nobody here can read it
- **You can upload a photo of your ID in your profile, and your coaches can show it to a referee before a game.** It is encrypted on your own device before it leaves it. The club cannot read it — not the committee, not the admins, not the server. Only you and the coaches and team responsibles of your teams hold a key to it.
- **Coaches see them from 45 minutes before kickoff.** They can download them beforehand, because halls usually have no signal, and the documents are removed from the phone again once the game starts. Every time someone opens an ID, it is recorded.
- **This is real encryption, and it has a real consequence.** There is no master key and no way for anyone at the club to recover your document. If you reset a forgotten password, your key is lost with it and you simply upload your ID again. Changing your password from inside the app is safe — it keeps your key.
- Only members who have logged in can have a document, because the key is made from your password. There is no way around that without the club being able to read your ID, which is the one thing this is for.

### Fixed: away games were showing the wrong list
- **The Einsatzliste for away games was never being read.** Wiedisync only ever looked at the home team's list, so for away games it quietly fell back to the RSVPs — which meant a nominated player who had not RSVP'd was simply missing from the sheet, in the away hall, which is exactly where a referee is most likely to ask for it. Away games now show the real Einsatzliste, the same as home games.
- Officials are now listed with their role (coach, assistant coach 1, assistant coach 2) instead of as one anonymous list. Volleymanager knew this all along; Wiedisync was throwing it away.

## v1.42.0 — 2026-07-13

### New: the Einsatzliste can file itself
- **Volleymanager's Einsatzliste can now be filled in automatically from the RSVPs.** About an hour before a game, Wiedisync takes everyone who confirmed, matches them to their Swiss Volley licence, enters them into the Einsatzliste in Volleymanager, and closes it. This works for away games too, not just home games.
- **It is off by default, and you turn it on per team** (Team settings → Game defaults), or per game if you want to override the team's setting for one match.
- **It will not close a list that Volleymanager is unhappy with.** If Volleymanager warns that the list is too short or has no coach — the kind of thing the club can be fined for — Wiedisync enters the players but leaves the list open and tells you to check it. It never files a list you could be fined for without a human looking at it.
- Only players who hold a licence can be nominated, so anyone who confirmed but has no licence number on file is reported rather than quietly dropped.

## v1.41.0 — 2026-07-13

### Fixed: the member list was empty when inviting people to an event
- **If you are a coach or a team responsible, creating an event now shows the full member list again.** The invite picker was coming up empty — not because nobody matched, but because the app was not allowed to read one of the fields it was searching on, so the request was rejected and the list silently came back blank. No error was ever shown, which is why it looked like "no members found". Fixed for every coach and team responsible.

### For admins: ClubDesk consistency check
- The ClubDesk sync page now has a **Consistency check** that lists everything which has drifted between ClubDesk and Wiedisync, with an Excel worklist to work through: members in **no ClubDesk group**, members **missing** their team's group, **coaches** missing their coach group, people **in a ClubDesk group but not on the roster**, and members **paying a playing fee while on no roster**.
- Each team's ClubDesk group is now stored on the team itself, so a new team can no longer be silently skipped by these checks.

## v1.40.0 — 2026-07-13

### Data explorer: ClubDesk sync + registration files
- **New "ClubDesk sync" column** — see at a glance whether each member matches the club register: *In sync*, *Drift* (a field differs), *Pending push*, *Not linked*, *Stale link* or *Departed*. Groupable, so you can pull up everyone who is out of step.
- **New "Reg. files" column** — the documents a member uploaded when they registered are kept after approval, and can now be opened straight from the grid.
- **The column header row and the name column stay put while you scroll**, so you always know which column you are looking at.
- **More inline editing**: sex and preferred language are now dropdowns, and scorer (VB) / Wiedisync active toggle with a click. Yes/no columns show a checkmark only when true, so the ones that are set stand out.

### Your registration documents
- **Profile now has a "My documents" card.** The ID and licence documents you uploaded when you registered are kept, and you can open them again any time. It only appears if you have documents.

## v1.39.0 — 2026-07-12

### Data explorer: team view
- **The grid now has a Members | Teams toggle.** The team view lists every team with its full roster, coach and team responsible as editable chips — add or remove people with a searchable picker, and edit team name, full name, league and season in place.
- **Nine more member columns**: sport, scorer (VB), referee (VB/BB), officials licence, Wiedisync active, last online, and passive / honorary / former membership (from the club register).
- Export, sorting, search and the column chooser work in both views.

## v1.38.0 — 2026-07-12

### Club news in your notifications
- **Published announcements now appear in the notification bell** for everyone in the announcement's audience, with a megaphone icon — tapping one opens the news page. Works regardless of email/push preferences, like all in-app notifications.

## v1.37.0 — 2026-07-12

### Newsletter emails
- **Announcements can now go out as a real newsletter.** A new email layout option in the announcements composer sends a wide masthead design — club logo and wordmark, the announcement image as a hero, a large headline and a clear call-to-action button — instead of the compact notification card.
- **Replies reach a real person.** Each emailed announcement can carry a reply-to address (prefilled with the sending admin's email). Leave it empty to keep no-reply.

## v1.36.0 — 2026-07-12

### Data explorer grid view
- **A spreadsheet view of all members.** The Data explorer now has a grid mode (toggle in the header, ClubDesk-style): a team rail on the left with member counts, and a dense sortable table on the right. Shows first / last name by default — add any of 19 columns (contact data, birthdate, licence, fee category, teams, …) via the column chooser.
- **Edit in place.** Sport admins and above click any cell to edit it — changes save field-by-field and are audit-logged. The Teams column adds or removes team memberships directly (guest memberships marked with a dashed "G" chip).
- **Group, search, export.** Group rows by team, city, nationality, birth year and more; the header search matches every column; export the current view to Excel or PDF.

### Tidier admin menu
- The Admin dropdown is now organized into sections — Planning & halls, Game operations, Members & communication, Data & insights — on desktop and in the mobile menu.

## v1.35.0 — 2026-07-11

### Your duties, everywhere
- **Your assigned duties now surface across the app.** The games you're the scorer / scoreboard / referee / BB official for show as a yellow reminder on the home page (from a week before until the game ends), as an entry in **My next appointments**, and on the **Events** page — no filter hides them.
- **Duties are automatically added to your calendar subscription.** Whatever you subscribe to (games, trainings, events, a single team), your own duties now ride along automatically — the separate "duties" link is gone. Also adds referee duties, which the feed was missing.
- **Pending duty hand-offs show on the home page.** When someone delegates a duty to you, you can accept or decline it right from the home page instead of opening the scorer page.

### Emergency help at the hall
- **"Emergency: contact team leaders" button.** In the hour before kick-off, an on-duty official can reveal the playing team's coach / team-responsible phone and email and alert the club (admin + sport TK) in one tap.
- **The coach's "report late" button now appears only once the official is actually late** — 29 minutes before the start for the scorer / referee, 14 for the scoreboard.

### Automatic no-show fines
- **No-show fines are issued automatically.** When a coach flags a scorer / official as late or absent via the emergency button, the CHF 50 duty fine now lands on that person automatically, using the team's fine rules (tiers) when configured.

## v1.34.1 — 2026-07-09

### Participation export polish
- **Multi-day events now export per-day participation.** The PNG / PDF / CSV roster export of a per-day / per-session event used to collapse each person to one status; it now shows their answer for **each day** (matching the modal's day tabs). Exporting a single day's tab labels the day in the header.
- **Position summary no longer warps.** Multi-word position labels ("Outside hitter", "Middle blocker") stopped wrapping mid-word in the export's summary pills.
- **No more duplicate coach in the staff list.** A playing coach who already appears in the roster with a "(Coach)" badge is no longer also listed as a "(Staff) — No response" row in the export (and the modal's staff section).

## v1.34.0 — 2026-07-09

### ClubDesk group checks in Data Health
- **Data Health now cross-checks Wiedisync team rosters against ClubDesk groups** and flags three kinds of drift: players who are missing their team’s ClubDesk group, people sitting in a ClubDesk group without being a current player of that team (annotated active / official / coach so “remove vs add” is obvious), and ClubDesk groups with no matching Wiedisync team. ClubDesk group membership can only be set by hand in ClubDesk, so these are surfaced for manual review — never auto-fixed.

## v1.33.0 — 2026-07-09

### “Staff only” position
- **New “Staff only” position** replaces “Other” in the volleyball and basketball position pickers — a clearer way to mark a non-playing coach / team responsible. “Other” stays valid for legacy / position-less members but is no longer offered. Existing non-playing staff (coach/TR whose only position was “Other” or empty) were converted to “Staff only”.

## v1.32.0 — 2026-07-09

### Volley referees admin page
- **New `/admin/vb-referees` page** (admin + VB admin): a standing referee → team duty map. Assign each `referee_vb` member to the team(s) whose referee obligation they cover (many-to-many), or flag “External” (+ optional club/pool) for duty outside Wiedikon. Doubles as a coverage check (teams with no referee / referees with no duty). New `vb_referee_duty` collection (migration 200). Not yet wired into scorer assignment (phase 2).

## v1.31.0 — 2026-07-09

### Multi-day events: respond per day (+ per-day fixes, guest filter)
- **Per-day RSVP on the card**: for events in per-day / per-time-slot mode, the card no longer writes a single session-less whole-event row (which left the roster's day tabs empty while the overall view showed N/2). It now shows quick Yes / Maybe / No that apply to **every** day at once, plus a **Per day** button opening the day-by-day responder.
- **Editing keeps sessions in step**: changing a per-day event's start/end dates now regenerates its day rows to match — they used to stay stranded on the original days (e.g. a Sat–Sun weekend whose sessions still read Fri–Sat) — and saving no longer 500s on empty session times.
- **Guest filter**: the multi-team participation modal can be narrowed to just guest players, with each guest's level shown next to their name.
- One-time data repair of the existing Trainingsweekend: whole-event answers mapped onto both days, stale session dates corrected, orphaned rows removed.

## v1.30.0 — 2026-07-09

### Filter a multi-team event roster by team
- **Team filter on the participation modal**: for events with 2+ invited teams, a new multi-select team dropdown sits alongside the status filter. Selecting one or more teams (default "All teams") narrows the **entire** modal — summary counts, member list, waitlist, coaching-staff section and all three exports (CSV / PNG / PDF) — to just those teams. Shared players (on two invited teams) show under either. Hidden for single-team activities (games/trainings) and club-wide events. Counts recompute from already-loaded data (no refetch). Frontend-only; extended `useMultiTeamMembers` with a member→teams map so the dedupe doesn't drop the team association.

## v1.29.0 — 2026-07-08

### Issue a fine directly + branded confirmation dialogs
- **Standalone "Issue fine"** on the Fines page (`/fines`): coaches / team responsibles (their teams) and admins/Vorstand (any active team) can pick a team + member and issue a fine directly — the amount pre-fills from that team's fine catalog (escalation engine), overridable. Previously the only entry point was the roster's automatic late-sign-in prompt. Frontend-only; reuses the existing `IssueFineModal` + `fine_rules` engine.
- **No more native browser pop-ups**: every `window.confirm` / `alert` in Club finances (expense paid/rejected, ledger + team-entry delete, invoice cancel, dues-email live switch, export error) now uses the app's branded, dark-mode-aware modal (`useConfirm`) or a toast. The rest of the app already used these. New convention documented in `CLAUDE.md`: native browser dialogs are banned.

## v1.28.0 — 2026-07-08

### Shared internal note on expenses
- **Back-office note between finance, TK and admin**: each expense reimbursement gains an `internal_note` (migration 193) that finance/admin edit on the Expenses tab and the section TK edits on the Confirm-expenses page. All three roles see the same text; it is **never shown to the member** (separate from the member-facing "note to the member" and the TK's own note to the treasurer). Written through the existing `PATCH /kscw/expenses/:id` and `POST /kscw/expenses/:id/tk-confirm` endpoints (raw knex + audit log).

## v1.27.0 — 2026-07-07

### Home "next 7 days" ticker + team birthdays
- **Upcoming ticker on the home page**: a full-width auto-scrolling banner surfaces everything in the next 7 days for the user's team(s) — games, trainings, events, hall closures/holidays, the member's own scoring duties, and 🎂 birthdays — in one place. Scoped to the user's teams; **admins see all teams** (global admins everything, VB/BB admins their sport). Pauses on hover, honours reduced-motion, and hides itself when nothing's coming up. Reuses the calendar's data engine (team-scoped, authed).
- **Birthdays in the team calendar**: a new `birthday` entry type (cake icon) shows team members' birthdays, **visible only to that team — never public**. On by default for logged-in users, toggleable under Filter → "Birthdays"; the detail popup shows the age. Sourced through the `member_teams` junction so a user only ever sees their own teams' birthdays.
- **Privacy**: only members whose `birthdate_visibility` is "full" appear in any birthday surface — "year only" (day/month hidden) and "hidden" members are never shown a birthday marker. Frontend-only change; no schema migration.

## v1.26.0 — 2026-07-07

### Standardized contact data + smarter signup form
- **One canonical format everywhere**: phone (`+41 79 123 45 67` / compact E.164 for foreign), IBAN (compact uppercase, mod-97 verified), AHV (`756.1234.5678.97`, EAN-13 check digit verified), email (lowercase). Enforced at every write path — registration, profile edit, ClubDesk sync both directions — with a one-time backfill of existing data (migration 186, ~290 phones repaired). Rule documented in `INFRA.md → Contact-data normalization rule`; parity-tested mirrors in backend/frontend/SQL/website.
- **Signup form (kscw.ch)**: validates AHV check digit, phone and email before submitting, and gains an **optional IBAN field** — collected only for paying money back (expense reimbursements), never for fee collection. Server-side guards mirror the client (localized errors), including the AHV-required rule (VB under 23 / BB under 25). Approved registrations carry the IBAN into the member profile as confirmed.
- **Wiedisync ID becomes a UUID** (migration 184, `members.uuid`): the ClubDesk round-trip key is now globally unique and visually distinct from ClubDesk's own numeric IDs. Legacy numeric stamps stay valid — the sync linker accepts both formats.

## v1.25.0 — 2026-07-07

### Scorer duty: HU20 referee + no-licence assignment
- **HU20 home games** are now staffed **scorer + referee** instead of scorer + Täfeler (scoreboard). The referee is a duty *team* like the scorer (no licence required); a member of the assigned team claims it on the Scorer page. (Backend: migration 182 adds the referee duty columns; migration 183 makes the "missing duty" report HU20-aware.)
- **Scorer and Täfeler no longer require a licence** — the auto-assignment can use any available team, and **MiniVB and DU20** are excluded as duty providers. The Legends and HU20 scoring preferences are kept.

## v1.24.0 — 2026-07-07

### Club stats: pick a season
- Club statistics now has a **season selector** (next to the sport toggle) defaulting to the current season. The **Schreiber coverage** and **win/loss results** sections previously aggregated across *all* seasons, so at a season start they were dominated by the finished season's data — they now follow the selected season, with past seasons still available to look back. Roster, member, participation and missing-duty sections stay current-state as before. (Backend: migration 181 adds a `season` dimension to the `stats_schreiber_coverage` view.)

## v1.23.0 — 2026-07-07

### Scorer assignment tool for admins
- New **Scorer assignment** admin page (Admin menu): auto-assigns scorer and Täfeler (scoreboard) duty *teams* to home games for both volleyball and basketball, using licence data (`members.scorer_vb` for VB, OTR licences for BB) and a scoring engine (fair rotation, sequential-game bonus, training/venue rules). The page was already built but unlinked — it becomes usable now that scorer licences are populated from the ClubDesk sync.
- Per-team summary at the top (own games + scorer / Täfeler / combined / total duties), editable per-game team assignments before saving, and a collapsible panel documenting the algorithm's hard and soft rules — split by sport, since volleyball and basketball use different engines. It assigns duty *teams*; the individual official is still chosen afterwards (self-claim / admin / delegation) on the Scorer page.

## v1.22.0 — 2026-07-06

### Expense reimbursements: status tracking
- The `/finance/expense` upload flow now persists every submission (`finance_expenses`, migration 177) instead of only emailing finance. Members see their submissions with status (pending / paid / rejected) + any finance note under "My submissions", and can re-open their receipt.
- Members are notified (in-app + email + push, in their language) when finance marks an expense paid or rejected.
- New **Expenses** tab in Club finances for the finance role/board: full queue of submissions with status changes, a note to the member, detail corrections and receipt access. Marking paid auto-creates the linked payout record (QR-bill snapshot) on the member's My finances page.

## v1.21.2 — 2026-07-06

### Calendar: hall closures show every affected hall
- A closure covering several halls (one `hall_closures` row per hall, same reason + dates) collapsed to a single hall in the calendar — "Halle geschlossen · KWI A" even when KWI A, B and C were all closed. The per-hall rows now merge into one entry listing every hall ("KWI A, B, C"), matching the public website's calendar.

## v1.21.1 — 2026-07-06

### Dates follow your language
- Weekday and month **names** (game detail dates, calendar weekday headers, hallenplan day navigation, scorer rows, event badges/forms, participation sheets, scheduling dialogs, date pickers) now render in the active UI language — Italian/French/English users no longer see German day and month names. Numeric dates keep the Swiss `dd.mm.yyyy` format app-wide per the existing convention; only named parts localize.

## v1.21.0 — 2026-07-04

### Data health: ClubDesk drift detection
- New **"Out of sync with ClubDesk"** check (superadmin): members whose wiedisync contact data (name, email, phone, address, birthdate, sex) no longer matches ClubDesk — with the exact field differences shown. One click marks them for the next sync-up; the push still goes through the usual preview.
- New **"ClubDesk missing data"** check: fields wiedisync has but ClubDesk lacks are grouped into a single bulk row per field (e.g. 100+ members whose sex is only recorded in wiedisync) — one click marks them all.
- This catches every edit path that previously bypassed the sync-up flag (admin edits, Data Explorer, approval backfills), so wiedisync and ClubDesk stay matched.

## v1.20.0 — 2026-07-04

### Registration documents are now enforced
- Basketball registrations can no longer be created without their required documents. The website form uploads each document **the moment it is picked** (with visible per-file status), and the registration is only submitted once every required document is uploaded — a failed upload is caught before anything is saved, instead of stranding a document-less registration.
- **Approval is blocked** while required documents are missing (ID front/back + licence application; non-Swiss players additionally the two FIBA declarations) — with a clear message on the Anmeldungen page.
- New **"Dokumente nachreichen"** page on the website: families can submit missing documents later using the reference number + email from their confirmation — no re-registration needed.

---

Older releases (v1.19.0 → v1.0.0) live in [CHANGELOG-archive.md](CHANGELOG-archive.md).
