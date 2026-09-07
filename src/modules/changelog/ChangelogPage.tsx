import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Coffee, ScrollText } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { useDonateVisible } from '../support/donateConfig'

const APP_VERSION = '2.6.0'

interface ChangelogEntry {
  version: string
  date: string
  sections: { title: string; items: string[] }[]
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '2.6.0',
    date: '07.09.2026',
    sections: [
      {
        title: "The SQL console suggests the right thing",
        items: [
          "Superuser tool \u2014 Admin \u2192 SQL workspace.",
          "Typing a table\u2019s name or its alias now suggests only that table\u2019s columns. `mt.` after `FROM member_teams mt` offers member_teams and nothing else; before, it offered every column in the database and let you pick one that did not exist on that table. The abbreviation works even before the FROM line is written.",
          "Values are suggested too. After `sport = ` the console offers 'volleyball' and 'basketball' \u2014 the values the column actually holds, read from the database rather than guessed.",
          "A suggestion says which table it comes from: columns are offered, and inserted, already qualified.",
          "The explanation panel no longer covers the suggestions on a phone. It sat on top of the list it was explaining.",
          "A failed query now offers \"Did you mean\u2026\". A mistyped column is matched against the tables that query actually joined, and one tap corrects it.",
          "Ask AI writes the values correctly and remembers the conversation. It is given the real values each column holds, so it writes 'volleyball' and not an invented 'vb', and it knows today\u2019s date, so \"this season\" means the current one. Your last few questions stay in context, so a follow-up refines the query instead of starting over.",
          "The console works on a phone. The three controls share one bar, write mode is a switch, and the schema browser \u2014 which was desktop-only \u2014 opens in a panel showing each column\u2019s type, keys and values.",
        ],
      },
      {
        title: "Fixes",
        items: [
          "The RSVP row no longer reads as unanswered while your answer is still loading.",
          "The officials on a game no longer read as \"nobody assigned\" while the screen is still loading. The heading appeared over an empty list, and if the second request failed it stayed that way.",
          "A team that is full is now refused by the contact form as full. The website already hid a full team\u2019s contact button, but a bookmarked or cached page could still reach the form; only closed basketball youth teams were being turned away.",
          "Date of birth sits left of the shirt number on the scorer\u2019s match sheet, matching the coach\u2019s roster and the order a scorer reads it in.",
        ],
      },
    ],
  },
  {
    version: '2.5.0',
    date: '07.09.2026',
    sections: [
      {
        title: "The match sheet checks itself",
        items: [
          "The match sheet now shows, next to each nominated player, whether they actually said they are coming. A green tick means confirmed, an amber mark means \"maybe\" or no answer yet, and a red cross means they declined \u2014 nominated in Volleymanager but not turning up. The Einsatzliste still decides who plays; this only checks it against the replies.",
          "The same mark appears on the emergency bench list, where it answers the opposite question: who confirmed but was never nominated.",
          "Where there is no Einsatzliste to check against, the column stays hidden rather than showing a row of ticks that verified nothing.",
        ],
      },
      {
        title: "Admin mode now means what it says",
        items: [
          "Admin powers now require admin mode to be switched on, everywhere. Fifteen places let an administrator edit any team\u2019s roster, cancel activities, open other teams\u2019 sign-up lists or export club-wide data while admin mode was off. If you are an administrator and something you could do before now seems missing, switch admin mode on.",
          "Identity documents can now only be opened by a team\u2019s own coaches and team responsibles. Administrators were shown the button, but the documents are end-to-end encrypted and an administrator holds no key \u2014 so it could never have worked, and it reported \"0 documents downloaded\", which is the message meaning nobody had uploaded one.",
        ],
      },
      {
        title: "Fixes on the game screen",
        items: [
          "The buttons on a game no longer change while the screen finishes loading. For a coach the first button used to switch from the attendance list to the match sheet, with two more appearing above it \u2014 long enough that a tap could land on the wrong one.",
          "A scorer no longer sees a \"View roster\" button that only ever opened an empty list. The match sheet is the one they need.",
          "The venue no longer appears a moment after the rest of a game. Opened from your duty list, the hall and address were fetched only by a second request, so they filled in after the card was already on screen.",
          "The match sheet now states the right times when it is not yet available. It claimed to open three hours before the game; it opens 40 minutes before for the scorer and earlier for the team.",
        ],
      },
    ],
  },
  {
    version: '2.4.2',
    date: '07.09.2026',
    sections: [
      {
        title: 'The school\u2019s hall calendar',
        items: [
          'Basketball home games are no longer announced to the school as volleyball. The Kantonsschule Wiedikon hall calendar took the sport from where a fixture came from rather than from the team playing it, so every hand-entered basketball game was published as "VB" — all five upcoming home games at KWI.',
          'A basketball home date agreed with the opponent now reaches the school’s hall calendar. Until now only fixtures already published by Basketplan did, so eight agreed dates held the court in wiedisync while the hall administration’s calendar showed it free. Dates still being negotiated stay off it.',
          'A game that takes both halves of the hall now says so. Four upcoming fixtures use the full hall and were listed under one half only, which read as though the other were free.',
        ],
      },
    ],
  },
  {
    version: '2.4.1',
    date: '06.09.2026',
    sections: [
      {
        title: 'Basketball planner fixes',
        items: [
          'A game placed in the Spielplansitzung planner can now be edited from the calendar too. Tapping the date showed "Edit in the planner" next to it and then did nothing; that row now opens the same editor the planner grid uses (team, opponent, home/guest game, note, remove).',
          'A team that already hosts on a date is no longer offered more slots on it. The slot generator knew a team could not host while playing away, but not while already hosting \u2014 so it kept suggesting the rest of the day. It applies immediately, without re-generating the slot list.',
        ],
      },
    ],
  },
  {
    version: '2.4.0',
    date: '03.09.2026',
    sections: [
      {
        title: 'Basketball games can be corrected',
        items: [
          'A game on the basketball calendar can now be edited and deleted from the day it sits on. Tap the date, then "Edit" on the game: home or away, the date, the kick-off time, the hall and the opponent are all changeable. Until now a game could only be created \u2014 a fixture entered on the wrong side, or with a time that later moved, stayed wrong.',
          'Home games now appear on the basketball calendar. A home game recorded on the game calendar used to be invisible in the whole basketball section, even while it occupied the club\u2019s biggest court.',
          'A basketball home game in KWI now blocks that court for volleyball, the same way a game placed in the Spielplansitzung planner already did. Both sports read one list, so a court can no longer be offered to a volleyball opponent while a basketball game is standing on it. The planner grid and the ProBasket availability form stop offering it too.',
          'The manual game calendar is now reachable from the basketball section, in the tab bar next to the calendar, opening with the basketball games already filtered.',
        ],
      },
    ],
  },
  {
    version: '2.3.0',
    date: '02.09.2026',
    sections: [
      {
        title: 'A member who has left is now one button',
        items: [
          'The member page in the Data Explorer has a "Member left" button. It writes the whole departure at once: the register status, the exit date, club membership and app access switched off, and the person comes off their current-season team rosters. Past seasons are kept \u2014 the match sheets and the "who played for D2 in 2024/25" answer live there.',
          'Until now this had to be done column by column. Switching "Club membership" off on its own left the club register still saying the person is a member, with no exit date, and Data Health then reported them under "Former members without an exit date".',
          'A departure typed in here now clears the current team rosters, exactly as a departure coming from ClubDesk always has. The same event used to have two different outcomes depending on which side it was entered from.',
          'Deleting a member now says on screen that the ClubDesk contact stays. Nothing in wiedisync ever deletes a contact from the club register \u2014 so if somebody has simply left the club, "Member left" is the action that ends the membership properly and pushes the status and the exit date into the register at the next approved sync-up.',
        ],
      },
    ],
  },
  {
    version: '2.2.0',
    date: '01.09.2026',
    sections: [
      {
        title: "One login for the whole family",
        items: [
          "Parents who look after more than one child in the club can now do it from a single login. A bar at the top of every screen shows whose account you are using; tap it and pick another child. No second password, no logging out and back in.",
          "Each child keeps her own separate member record \u2014 her own team, her own RSVPs, her own fees and licence. Nothing about that changes. What changes is only who is allowed to sign in and act for her.",
          "Children who are looked after this way have no password at all and cannot sign in. That is deliberate: it means one fewer set of login details in circulation for a twelve-year-old, and a parent's access can be withdrawn completely at any time.",
          "The child's name appears inside the buttons themselves \u2014 \"Mila is coming\" rather than just \"Yes\" \u2014 so it is under your thumb at the moment you decide, and there is no doubt about who you just answered for.",
          "A child old enough to have her own login can remove a parent's access herself, from her profile. Private messages stay private either way: a parent managing RSVPs cannot read her child's conversations with teammates and coaches.",
          "Club admins can set families up under Options \u2192 Households.",
        ],
      },
    ],
  },
  {
    version: '2.1.8',
    date: '02.09.2026',
    sections: [
      {
        title: 'A fine the team owes now reaches the team',
        items: [
          'Open fines appear on the home page. Your own open fines and the fines your team owes as a team are shown together at the top, split so it stays clear which is which \u2014 the card only appears when something is actually open.',
          'A fine issued against a whole team now notifies that team. Team fines (a forfait, a missing scorer, a late match sheet) are paid out of the team fund and belonged to no single player, so nobody was told they existed: they were visible only to whoever happened to open the fines page. Everyone on the team \u2014 players and staff \u2014 now gets the notification when one is issued, marked as paid, or waived.',
          'Your fines list shows the team fines of your teams, marked "Whole team". They are kept out of your personal outstanding total, which stays exactly what you owe yourself.',
          'Fine notifications are translated and now open the fines page. They used to show an internal code instead of a message and took you to the home page when tapped.',
        ],
      },
    ],
  },
  {
    version: '2.1.7',
    date: '28.08.2026',
    sections: [
      {
        title: 'The duty overview updates as soon as you roll out',
        items: [
          'After rolling out a duty plan, the overview tab now shows what you just saved. It used to keep showing the picture from when you opened the page, so a duty team you had changed still appeared under its old team until you reloaded — the one view meant to confirm what is committed was the one showing stale information. The change itself was always saved correctly; only the display lagged.',
        ],
      },
    ],
  },
  {
    version: '2.1.6',
    date: '28.08.2026',
    sections: [
      {
        title: 'A cup home game can now be given a duty team',
        items: [
          'Cup home games can be assigned a duty team and a person on the scorer assignment page. Until now the row was read-only: nobody is summoned for cup duty by default, because the playing team covers its own cup match — but there was no way to put somebody on it when you wanted to. The row now has the same team and person pickers as every other game, and stays marked "On call" for as long as you leave it empty.',
          'Once you do assign somebody, the duty behaves like any other: it appears on their scorer page and it counts toward that team\u2019s share of the season\u2019s duties. Recomputing the plan keeps it.',
        ],
      },
    ],
  },
  {
    version: '2.1.5',
    date: '28.08.2026',
    sections: [
      {
        title: 'Cup home games show up in the duty overview',
        items: [
          'A home cup game no longer disappears from the duty overview on the scorer assignment page. Nobody is summoned for cup duty — officials are on standby instead — and the overview only listed games that had a duty team, so a cup game we host vanished from the one view used to check that every game is covered. It now stands in the list as "On call", and is not counted as an unfilled duty.',
        ],
      },
    ],
  },
  {
    version: '2.1.4',
    date: '28.08.2026',
    sections: [
      {
        title: 'Changing your profile photo works with a photo from your camera',
        items: [
          'Picking a photo straight off a phone or camera now works. Anything over 5 MB was refused, and almost every photo a modern camera takes is bigger than that — so choosing one appeared to do nothing at all, and the old picture stayed. The app now shrinks the photo for you before uploading it, so any size goes through.',
          'On the rare occasion a photo really cannot be used, you are told so next to the button instead of in a message far below the bottom of the form, and picking the same file again works rather than being silently ignored.',
          'The same fix applies to the member photo in the admin member editor.',
        ],
      },
    ],
  },
  {
    version: '2.1.3',
    date: '27.08.2026',
    sections: [
      {
        title: 'The reply counts on a game match the roster again',
        items: [
          'A game card no longer counts a "no" from somebody the roster does not list. Guest players cannot be entered on a match sheet, so they are left off every game roster — but when one of them filed a holiday the app still wrote them a "no" for each game in that window, and the red counter on the card counted it. A card read "1 declined" over a roster where nobody had declined. Those replies are gone, and no new ones are written.',
          'One player was also carrying a "no" on the other team\'s copy of the H1 v H3 derby, left behind by a sync fault in July that briefly moved the fixture between the two teams. Removed.',
        ],
      },
      {
        title: 'A game you were called up to shows on the games page',
        items: [
          'Being called up to another team\'s fixture now puts it on your games page, where it belonged all along — until now it appeared on your home page and in your calendar but never in the games list, so the whole H3 squad opened up for H1\'s cup tie could not find it. It stays there whichever team you filter by: a call-up is yours personally, so no team chip hides it.',
        ],
      },
    ],
  },
  {
    version: '2.1.1',
    date: '26.08.2026',
    sections: [
      {
        title: 'The app no longer hangs on the loading screen',
        items: [
          'Logging in and then watching the logo spin — sometimes for minutes, sometimes until the page gave up — is fixed. The app was asking the database one question that had quietly become enormously expensive, and at busy times, like everyone checking in before training in the morning, those questions piled up until nothing got through. It now answers in well under a second.',
          'Who has replied to a club or multi-team event is visible again. On events that span more than one team — the Photoday, a mixed tournament, a Trainingswochenende — you could only see the replies of people on your own team, so a well-attended event looked like nobody had answered. You now see the whole list.',
          'Players called up to another team\'s game, and that team, can see each other\'s replies again — so the coach picking the squad sees a full roster instead of blanks.',
          'Various pages now ask the server for far less than they used to. Trainings, games, the scorer list and team chat used to reload everything whenever anyone anywhere changed a reply; they no longer do.',
          'The notification bell and the news feed now agree with each other: reading a news item marks it read in both places straight away.',
        ],
      },
      {
        title: 'The sign-up form asks which federation licensed you first',
        items: [
          '"None" is gone from the federation-of-origin question. Nobody is without a federation: if no association has licensed you before, the one issuing your first licence — Swiss Volley or Swiss Basketball — is your federation of origin, so the answer is Switzerland. It was the first option in the list and was being chosen by most people who answered, nearly all of them juniors getting their first licence from us.',
          'The question changed with it: which federation licensed you first, not which one licensed you at 14. Under the old wording someone first licensed abroad at 20 truthfully answered "nobody at 14", and the club never learned to request their transfer certificate before they could play.',
          'Members who had answered "None" now read as Switzerland, except where their nationality is not Swiss — those appear on the club\'s transfer list so somebody asks them, rather than the club quietly assuming.',
        ],
      },
    ],
  },
  {
    version: '2.1.0',
    date: '26.08.2026',
    sections: [
      {
        title: 'Games, trainings and events can carry a meeting time',
        items: [
          'When a team meets before the start — Besammlung — is now on the record next to the start time, instead of living in the training notes, a chat message, or nobody\'s head. It shows in the game, training and event details, and in the calendar.',
          'Games default to an hour before the first whistle and trainings to ten minutes before the start; both are already filled in on every existing game and training. Events have none unless you set one, because most of them do not need one.',
          'The coach sets how long before the start the team meets, and the app works out the clock time. That means a game moved by Swiss Volley brings its meeting time with it: a 16:00 game meeting at 15:00 that moves to 18:00 now meets at 17:00, with nobody having to remember to change it.',
          'Events take a plain time instead, so an all-day tournament can still say "be there at 08:30" — the case where a meeting time matters most.',
        ],
      },
    ],
  },
  {
    version: '2.0.0',
    date: '26.08.2026',
    sections: [
      {
        title: 'Coaches who set up their key late can be given access to identity documents',
        items: [
          'An identity document is locked to the people named when it is uploaded, and nobody else — not the club, not an administrator. That is deliberate, but it had a sharp edge: a coach who set up their identity key after their players had uploaded was never given a key, so they could open nothing. It only became apparent when they tried to show the documents at a match. One team had nine documents its own coach could not open.',
          'Your profile now tells you when someone on your team\'s staff cannot open your document, and gives you a button to grant them access. Your document is not uploaded again, and nobody outside your own coaches and team responsibles can ever be added.',
          'A coach or team responsible who can already open a team\'s documents can restore access for a colleague across the whole team at once, from the team page. This is the only way it can work: the club\'s servers have never held the key, so only a device that can already open a document is able to pass access on.',
          'If you cannot open a player\'s document at a match, the app now says so and tells you how to get access. Before, it simply downloaded nothing and gave no reason.',
        ],
      },
      {
        title: 'You can see who can open a team\'s identity documents',
        items: [
          'Coaches and team responsibles have a new "Document access" view on the team page, listing every uploaded document and exactly who can open it. Being on a team\'s staff does not by itself grant access, and until now there was no way to tell the difference.',
          'It distinguishes the cases that need different action: who can open it, who is waiting for access to be restored, who has not set up an identity key at all — which nobody else can fix for them — and who has left the team but still holds access, because removing someone from a team does not reach into their phone. Only uploading the document again withdraws that.',
        ],
      },
    ],
  },
  {
    version: '1.99.1',
    date: '25.08.2026',
    sections: [
      {
        title: "Your team's calendar shows every game",
        items: [
          "A team's games now come from the official Swiss Volley fixture list instead of being pieced together from the hall bookings made while arranging them. Any game that never went through our own booking process was simply missing — the H1 v H3 derby above all, which by definition has no booking because both sides are us. H3's calendar showed 17 of its 19 games; the missing two were the derby and an away game the opponent scheduled directly.",
          'Kick-off times and venues are the federation\'s own. The calendar used to show the hall reservation window rather than the real start — 19:30 for a game that starts at 20:00 — and away games showed no venue at all. If a game is moved after we booked the hall, the calendar now follows the move instead of showing the old date.',
          "A game says who you are playing. Every entry on a team's calendar used to read that team's own name, over and over, with the opponent hidden in a tooltip.",
        ],
      },
    ],
  },
  {
    version: '1.99.0',
    date: '25.08.2026',
    sections: [
      {
        title: 'The J+S export matches what the national database accepts',
        items: [
          'Training length is now always reported as 90 minutes. Jugend+Sport only accepts 60, 75 or 90, and we were sending the measured block length — 105 or 120 — which made the national database refuse the file. Matches no longer carry a duration at all, as the J+S rules require.',
          'Full-day activities are reported as 4 or 6 hours, the only two lengths J+S allows. A four-and-a-half-hour event used to be sent as 4.5 hours and rejected.',
          'The export now warns you before you download if any training has no location or no time. Both are mandatory, and until now the file was only refused after you had uploaded it.',
        ],
      },
      {
        title: 'The training plan runs to the summer holidays',
        items: [
          'Trainings are now created for the whole planned season instead of the next twelve weeks. The hall plan runs to August 2027, but only about three months of it existed as actual sessions — so the calendar, and the J+S activity list built from it, ran out in November for most teams and at the end of May for the rest.',
          "Every team's plan now reaches mid-July 2027, stopping by itself at the summer holidays. School holidays, Sportferien, Easter, Whit Monday and every hall closure are skipped, as before.",
        ],
      },
    ],
  },
  {
    version: '1.98.1',
    date: '25.08.2026',
    sections: [
      {
        title: 'A failed ClubDesk sync now says so',
        items: [
          'A sync that failed used to look like one that worked. The time under the button was stamped whether the sync succeeded or not, so a failed run showed a fresh "last sync" and the club register quietly stayed out of date. That line now only ever shows the last sync that actually succeeded.',
          'When a sync does fail, the page says why — whether ClubDesk did not respond, refused the login, or our own tool could not start — instead of pointing at a log file only a developer can open.',
        ],
      },
    ],
  },
  {
    version: '1.98.0',
    date: '25.08.2026',
    sections: [
      {
        title: "Former members' details are deleted after a year",
        items: [
          'When somebody leaves the club, their contact and payment details are now erased twelve months later. Bank details, AHV number, phone, address and email address are removed for good. Name, date of birth, the teams they played in and their dues history are kept, so the club\'s own record of who played when stays intact.',
          'Nothing is deleted automatically. Each erasure is a decision an administrator takes, and it is recorded in the audit log. Invoices keep the address they were issued to, so the club\'s accounts stay complete.',
        ],
      },
    ],
  },
  {
    version: '1.97.1',
    date: '25.08.2026',
    sections: [
      {
        title: 'The trainings list stops asking the same question 47 times',
        items: [
          'Pages with a long list of trainings, games or events were slow to settle, worst of all on a phone. Every single card asked the server on its own whether you were marked absent that day. A season view of the trainings page meant 47 separate questions where one would do — 94 of the 155 requests on that page, all for an answer the app could have looked up once. The requests then queued behind each other, so the same trivial lookup that normally takes 50 milliseconds was taking 650.',
          'The app now fetches your absences once and works out the rest itself. Nothing changes about what you see — the "Absent" and "Unavailable" markers behave exactly as before, they just appear without the wait.',
        ],
      },
    ],
  },
  {
    version: '1.97.0',
    date: '24.08.2026',
    sections: [
      {
        title: 'When somebody leaves the club, the app notices',
        items: [
          'A contact deleted from the club register no longer goes unnoticed here. If somebody is removed in ClubDesk, the app used to keep them on their team, on the team\'s mailing list and in the roster counts indefinitely — it could see the link was broken but had nothing to offer about it. An administrator now gets the choice: restore the link, or end the membership, which also takes the person off every current team.',
          'Departures are now dated. The app records when a membership was switched off, so the club can tell how long a former member\'s data has been kept. That is the first step towards deleting what it no longer needs.',
        ],
      },
    ],
  },
  {
    version: '1.96.1',
    date: '20.08.2026',
    sections: [
      {
        title: 'Avatars stay round when there is no photo',
        items: [
          'A member without a photo showed a squashed oval, not a circle. In a team roster on a narrow screen the initials badge was pressed down to 19 of its 32 pixels wide while keeping its full height. Members with a photo were never affected, which is why it looked arbitrary: a browser lets a circle of text shrink to the width of the text, but gives a picture its full size to hold on to.',
          'The badge now keeps its shape everywhere it appears — team rosters, the add-member list, the profile page, the profile editor and the avatar in the top bar. On a tight row the name wraps one line further instead, exactly as it already did next to a photo.',
        ],
      },
    ],
  },
  {
    version: '1.96.0',
    date: '15.08.2026',
    sections: [
      {
        title: 'Your invoice now shows what goes to Swiss Volley',
        items: [
          "The membership fee is itemised. A volleyball invoice used to show one number; it now shows the club's own fee and the Swiss Volley licence separately — CHF 330 plus a CHF 110 regional licence, for example, instead of a bare CHF 440. Nobody pays more: the licence was always inside the fee, and the total is unchanged.",
          'The website said the opposite. kscw.ch stated that licence fees were not included in the membership fee and were billed alongside it. They have always been included, and no invoice ever carried a separate licence charge. The fee tables now show the licence share per category and the note has been corrected.',
        ],
      },
    ],
  },
  {
    version: '1.95.0',
    date: '15.08.2026',
    sections: [
      {
        title: 'A free membership now gets a bill that says so',
        items: [
          'If your membership is free, you get an invoice like everybody else — for CHF 0. It shows what a membership like yours would have cost and the exemption that cancels it, so "CHF 0.00" reads as a decision the club made rather than something that went wrong.',
          'Nothing to pay and nothing to do: it arrives already marked as paid, with no payment slip and no email. You will find it under Finances → My dues alongside your other invoices.',
        ],
      },
    ],
  },
  {
    version: '1.94.0',
    date: '15.08.2026',
    sections: [
      {
        title: 'The Database table only draws the rows you can see',
        items: [
          'First paint is down to about a tenth of a second. The table used to build all 711 rows whether or not they were on screen. It now renders only the visible ones: 0.4 s to 0.1 s on the default columns, and 0.8 s to 0.16 s with thirty columns showing. The page holds ~800 elements instead of ~13,000, so scrolling, sorting and searching are lighter too.',
          'Nothing about using it changed. Scrolling reaches every member, the scrollbar is the right length, the header and the name column still freeze, grouping still shows its section headings, and "select all" still selects all 711 and not just the visible ones.',
        ],
      },
    ],
  },
  {
    version: '1.93.2',
    date: '15.08.2026',
    sections: [
      {
        title: 'The Database table opens about three times faster',
        items: [
          'The table was building an editor for every cell, even though you were only reading. With 711 members and the new ten-column default that is ~7,800 editors, and every date cell carried a whole calendar. It now draws plain text until you switch editing on: first paint went from 1.1 s to 0.4 s, and from 2.0 s to 0.8 s if you have thirty columns showing.',
          'Switching editing on is quicker too — a date cell opens its calendar when you click it, instead of all 711 opening one in advance.',
          'Nothing about what you see changed: same columns, same Swiss dates, same values.',
        ],
      },
    ],
  },
  {
    version: '1.93.1',
    date: '15.08.2026',
    sections: [
      {
        title: 'Honorary, passive, gap year and former, per sport as well as club-wide',
        items: [
          'Each sport now lists its own register states. Volleyball and Basketball each hold Honorary, Passive, Gap year, Former and Non-members alongside Teams, Officials and Staff — so "which of our volleyball people are on a gap year" is a group rather than a filter you build yourself.',
          'The club-wide lists still count everybody, including the people already shown under a sport. They answer a different question: the club has 12 honorary members, of whom 3 are on the volleyball side and the rest belong to no section.',
          "Each sport's \"Other\" got smaller and more useful — 60 to 38 for volleyball — because a passive or gap-year member is now named as such instead of falling through to the leftovers.",
        ],
      },
    ],
  },
  {
    version: '1.93.0',
    date: '15.08.2026',
    sections: [
      {
        title: 'Every datapoint as a column, a working set of defaults, and an edit switch',
        items: [
          'The table opens with ten useful columns instead of two. Name, teams, email, phone, address, postal code, city, birthdate and register status — the set the club actually works in. A fresh browser used to show two name columns and nothing else until you went shopping in the column list. Note that this resets a column selection you had saved; pick your columns once more and it sticks.',
          'The column list offers every datapoint the page holds — 72 of them, up from 35. Nickname, section, licence status, trainer licences, ClubDesk flags, the shell-account fields and the rest are all columns now, read-only. What is not there is what the page does not load: about 46 more datapoints, mostly finance and notification settings, sit behind narrower permissions and asking for them would break the page for anyone who is not a full admin.',
          'The column list has a search box, grouped results and one-click show/hide. It searches German too — type "Geburtsdatum" or "Lizenz" and the right field comes up, even though the labels are English. "Show all" applies to whatever the search is showing, so "type ahv, show all" is two clicks rather than a hunt through a hundred checkboxes.',
          'Editing is now a switch you turn on. The table is read-only when you arrive, with an Edit button at the top; cells become editable, and the selection ticks for bulk actions appear, only once you press it. It never stays on between visits — this is a page you mostly scroll, and a stray click on a cell should not change the club\'s register.',
        ],
      },
    ],
  },
  {
    version: '1.92.0',
    date: '14.08.2026',
    sections: [
      {
        title: 'Each sport owns its own groups, and the table view is grouped the same way',
        items: [
          'Volleyball and Basketball each hold their own Teams, Officials, Staff and Other, instead of "Volleyball officials" and "Basketball staff" sitting in one flat list next to Gap year. Open a sport and everything about that sport is under it.',
          '"Other" is now what is left over, not "has no team". Somebody who scores but plays for no squad is under Officials, where you would look for them, and no longer padding the list you scan for the unexplained. Volleyball\'s Other went from 90 people to 60.',
          'The table view\'s sidebar uses exactly the same groups as the tree, so picking a group in either place means the same thing. It was a flat list of teams before, and there was no way to see, say, every basketball official as a table.',
          'A group\'s count and its rows now agree. Picking Former members showed 29 in the sidebar and 7 rows, because the group is built from everybody while the table was showing current members only.',
        ],
      },
    ],
  },
  {
    version: '1.91.0',
    date: '14.08.2026',
    sections: [
      {
        title: 'The Database tree now mirrors the club, not just the roster',
        items: [
          'The member tree had three groups — Volleyball, Basketball and "Other" — and it worked out which one you were in from your roster teams alone. Anyone without a roster row landed in "Other" no matter what the club knew about them: passive members, referees, new signups, and every coach and team responsible in the club, because coaching links are not roster rows. It now reads section and fee category too, so a member with no team lands in their own section under "No team".',
          'There are real groups now, close to the ones in ClubDesk. Volleyball and Basketball open into their teams. Alongside them: volleyball and basketball officials (scorers, referees, and the OTR1 / OTR2 / OTN1 / OTN2 grades), volleyball and basketball staff (coaches, team responsibles), club board, honorary members, passive members, gap year, former members, non-members and schedulers.',
          'You appear in every group you belong to. A player who also coaches and sits on the club board shows up in all three, the way ClubDesk works. Group counts are of people, not of entries, so nobody is counted twice in the number at the end of a row.',
          'Former members are on the page at last. The Database page only ever loaded current members, so 22 of the 26 people the register lists as "Ehemaliges Mitglied" were not there to be found. Everyone is loaded now, with an "Active club membership" filter switched on by default — the same people on screen as before, except the filter is one you can see and clear.',
          'A group nobody can place is still shown, as "Unassigned". It is four people today. That is a data question worth seeing rather than hiding.',
        ],
      },
    ],
  },
  {
    version: '1.90.0',
    date: '14.08.2026',
    sections: [
      {
        title: '"No transfer needed" is a decision you can record',
        items: [
          "The transfers page has a third status: \"Not needed\". Until now the only way to take somebody off the transfer worklist was to change their federation of origin — which is the member's own answer about where they were first licensed, not a checkbox for clearing a task list. Ruling a transfer out is now its own decision, recorded next to who made it, and it leaves their federation of origin exactly as it was.",
          'Members Swiss Volley already licenses as Swiss come off the worklist by themselves. Swiss Volley is the body that would ask for the transfer certificate, so where their register counts somebody as Swiss there is nothing for us to chase — whether that is because no transfer was ever needed or because one already went through. Those members now say so instead of sitting on the list looking untouched.',
          'Except the ones you are chasing anyway. Marking somebody Pending or Done always wins over the automatic answer, in both directions.',
          'The Volleymanager comparison table has a Decision column. Where our record and Swiss Volley\'s disagree, you can now settle it on the row that raised the question rather than somewhere else. The disagreement itself stays on screen afterwards — it is still the evidence that one of the two registers needs correcting.',
          'Members licensed in Switzerland can now be marked as being chased. That is the case that had nowhere to go before: our record says Switzerland, Swiss Volley\'s says a foreign federation, and nobody was following up a transfer that might well be required.',
          'Nothing disappears quietly. Everyone taken off the worklist is listed under it, with the count in the heading and the decision reversible — a shorter list always says why it got shorter.',
        ],
      },
      {
        title: 'Database view reads properly',
        items: [
          'Values are shown as words instead of database codes. Sex, language, positions and roles came out of the grid as raw stored values — on screen and in the Excel export. They now read the way they do everywhere else in the app.',
          'Headings and labels are no longer shouted in capitals, and the two VIS columns that showed up under an "Unmapped column" warning are now proper fields with an explanation of who writes them.',
        ],
      },
    ],
  },
  {
    version: '1.89.0',
    date: '14.08.2026',
    sections: [
      {
        title: 'Type or paste a date instead of clicking through the calendar',
        items: [
          'Every date field in the app now takes typing and pasting. Entering a birthdate meant paging a calendar back through twenty-odd years, one dropdown at a time; you can now just write 24.03.1998, or paste it straight out of a spreadsheet or ClubDesk. The calendar button is still there and works exactly as before.',
          "It reads the date the way you'd write it here. 24.03.1998, 24.3.98, 24/03/1998, 1998-03-24 and plain 24031998 all mean the same day. Day first, always — the same order the app shows dates in, so retyping what you see gives you back what you saw. On a phone, the digits-only form saves fighting the numeric keypad for a dot.",
          'A date that does not exist is refused rather than quietly moved. Typing 31.02.2026 outlines the field in red and changes nothing; before, that kind of input tended to become 3 March somewhere down the line. Unfinished typing is discarded when you click away, so a half-entered date never looks saved.',
          'The calendar no longer jumps up and down as you page through months. Months are four to six weeks long, and the popup used to resize with them — near the bottom of the screen that flipped it above the field and back again on the next month. It now keeps one height.',
        ],
      },
    ],
  },
  {
    version: '1.88.0',
    date: '14.08.2026',
    sections: [
      {
        title: "Membership fees are checked against the club's own rules",
        items: [
          "Data health now checks every member's fee against the rules the club actually follows: honorary members, board members and coaches pay nothing, passive members pay CHF 40, and everybody else pays what their category says. It reports, it never changes an amount — a mismatch is as often a wrong category as a wrong amount, and that is a decision for the treasurer, not for software.",
          'A team responsible is not a coach. Coaches are free even when they also play; team responsibles pay their normal fee. Getting that distinction wrong would have reclassified four correctly-billed members.',
          'Gap-year members are deliberately not judged yet — whether a Zwischenjahr owes anything is an open question, and flagging 28 people on a guess would be noise, not a finding.',
          'Members who owe nothing now get an invoice for CHF 0. It shows the rate they would have paid and the waiver that cancels it, so the books have a record for every member instead of only the paying ones. These are filed, never emailed — nobody receives a bill for nothing.',
        ],
      },
      {
        title: 'A fee category corrected here now reaches the member register',
        items: [
          'Changing somebody\u2019s fee category used to be undone again a few days later. The category was owned by the register, so an edit here was never sent — and the nightly sync quietly restored the old value. It now travels to the register like the membership status does, and the amount travels with it, so the register can never end up saying "free" next to a CHF 440 bill.',
          'A per-person amount set by the treasurer still wins. Correcting a category is not permission to throw away a price somebody set by hand.',
          'Fixes and corrections found by the same review: seventeen basketball juniors who were billed as members while the register called them non-members are now members; six juniors left behind by the basketball fee increase have been raised; one member\u2019s category moved out of the bucket meant for people who have left the club.',
        ],
      },
    ],
  },
  {
    version: '1.87.1',
    date: '14.08.2026',
    sections: [
      {
        title: 'Manually added games were missing from Home and Games',
        items: [
          "A game entered by hand in Spielplanung — or imported from the spreadsheet template — was stamped with the wrong season, and the season is what the home page, the games list and the website's fixture embed filter on. The game saved correctly and showed on the calendar and in Spielplanung, so it looked entered; it was simply invisible in the three places most people actually look. Found on a Herren 2 basketball away game.",
          "The season is now derived from the game's own date, in one place, so no entry route can stamp it differently. The one affected fixture has been corrected.",
          'The Spielplanung season picker no longer lists the same season twice — the current season was written in a different format from the seasons on record, so it showed up as its own extra entry.',
        ],
      },
    ],
  },
  {
    version: '1.87.0',
    date: '13.08.2026',
    sections: [
      {
        title: 'Set your own Kantonsschule',
        items: [
          'You can now set your Kantonsschule yourself, under Options → Profile. The signup form has always asked it, but only people who joined through the form ever had an answer on record — everyone else was blank, and there was no way to say so.',
          '“Nein” is a real answer, not a blank. It means you were asked and you are not at a Kantonsschule, which is different from nobody ever having asked.',
          'Only you and the club’s administrators see it — not other members, and not your coach.',
        ],
      },
    ],
  },
  {
    version: '1.86.0',
    date: '13.08.2026',
    sections: [
      {
        title: 'Which Kantonsschule a member attends',
        items: [
          'Members now have a Kantonsschule field. The signup form has always asked which Zurich Mittelschule an applicant attends, but the answer only ever lived on the application — invisible on the member, unfilterable and unexportable, and gone from view once the application was approved. It is now a field on the member, filled in for everybody whose application recorded one.',
          'Everyone else is blank, and that is the honest answer: most of the club joined before the form existed or came in through ClubDesk, so nobody has ever been asked. "Nein" is stored as a real answer and means asked and not at a Kantonsschule — different from blank.',
          'It is groupable in the grid, so "how many of ours are at KS Wiedikon" is one click. It can also be filled for many members at once with bulk edit.',
          'Section is now a dropdown instead of a free-text box. It only ever holds Volleyball, Basketball or KSCW, and those three are what decides which association fields you see and which section a member is administered under — a typo there did not fail, it quietly left somebody with no section at all.',
          'Pressing Enter in the search now banks whoever the search is showing and clears the box, so a selection can be built one name at a time without reaching for the mouse. The toolbar shows how many will be added before you press it.',
        ],
      },
    ],
  },
  {
    version: '1.85.0',
    date: '13.08.2026',
    sections: [
      {
        title: 'Assign coaches and team responsibles from the member',
        items: [
          'A member’s page now has three team fields instead of one: Teams (player), Teams (coach) and Teams (team responsible). Until now only the roster could be edited there — coaching and team-responsible links had to be set from each team’s own page, so answering "which teams does this person actually run?" meant opening every team in turn. The old routes still work and write the same records.',
          'They are deliberately three separate fields. Putting somebody in as coach does not add them to the squad — a coach on the roster would appear in the team list, in attendance counts, in the table-duty pool and in the club register’s player group as though they played. A player-coach is entered in both fields, which is what the club actually means.',
          'The help text on the roster field used to say coaching links were edited in the table below it. They were not — that table is read-only. It now points at the right place.',
          'All three can be set for many members at once from the bulk edit added in the last release, as add or remove only: replacing or clearing whole squads is not something a bulk action should offer.',
        ],
      },
    ],
  },
  {
    version: '1.84.0',
    date: '13.08.2026',
    sections: [
      {
        title: 'Edit many members at once',
        items: [
          'The member grid can now select rows. A tick box on every row and one in the header that takes everything currently listed. The selection survives changing the search or the filters, so you can search for one thing, tick a few, search for another, tick a few more, and act on all of them together — the count in the bar above the table is always the whole selection, not just the part you can see.',
          '"Bulk edit" writes one or more datapoints to everybody selected. You pick the datapoints the same way you pick them anywhere else in the explorer, and each one gets the same control the member’s own page uses — a dropdown stays a dropdown, an IBAN is still checked. Roles and team memberships can be added to or removed from what each member already has, rather than replacing it: adding a role does not clear the roles somebody already held.',
          'It tells you how many members it will actually change before you commit. "9 of 12 members will be updated. 3 already hold every value." The three that already match are left alone entirely — no write, and nothing in their history to suggest anything happened.',
          'Members are updated one at a time, and one failure does not lose the rest. If a section administrator selects somebody outside their own section, that member is reported by name and the others still go through.',
          'Fields where one shared value could never be right are not offered — names, email, phone, birthdate, AHV number, IBAN, jersey number. Each says why. Data-protection consent is excluded too: it is the member’s own declaration to make.',
          '"Mark as departed" ends membership for a whole group in one step. It sets the register status and the exit date and switches off club membership and app access together, because they are one decision — and asks once more, naming the number of people and the date, before it writes.',
        ],
      },
    ],
  },
  {
    version: '1.83.0',
    date: '13.08.2026',
    sections: [
      {
        title: 'ClubDesk sync and Data health are now one page',
        items: [
          'The two admin pages have become one. Data health used to report the ClubDesk problems as bare counts — "24 people are missing a group" — and then send you to a second page to find out who, while that second page had no idea what else was wrong. Both now live at Data health, and the counts have been replaced by the actual lists. The old address still works and takes you there.',
          'The findings are split by section. Tabs for volleyball, basketball, and everything club-wide, so the volleyball TK is not reading through basketball rosters to find their own. Members whose section cannot be worked out at all — no team, no volleyball or basketball fee category — get their own tab instead of quietly appearing under both sports, which is how they used to go unnoticed.',
          'A new "Needs syncing" list. Since the last sync, who is out of step with ClubDesk and why: not linked yet, link broken, left the club, waiting to be pushed, or a field that no longer matches. The times of the last sync down and sync up are shown next to it, and when the list is empty it says how many members are in sync — so an empty list reads as "everything is fine" rather than "the check did not run".',
          'Each person’s last invoice is shown next to the finding. Particularly on the members who pay a playing fee but are on no team: you can now see whether they were actually billed, whether it is still open, and how much, without opening finance in another tab. "Never billed" is called out as its own answer.',
        ],
      },
      {
        title: 'Fix ClubDesk groups from the app',
        items: [
          'The club’s ClubDesk groups can now be corrected from Wiedisync. ClubDesk has no interface for this that we can talk to, so until now a member missing their team’s group had to be fixed by hand, one contact at a time. The new "Fix groups" button does it for you: it adds missing player and coach groups, and removes ones that contradict the current roster.',
          'It always previews first. The preview does every step except the final save, and shows you row by row what it would do. Only then can it be committed, and it asks once more before writing. This is the club’s legal member register, so nothing about it is one-click.',
          'It deliberately refuses the ambiguous cases. Someone sitting in a team’s group with no roster entry is usually a missing roster entry, not a wrong group — those stay on the list for a person to decide, marked as such. It only removes where the answer is unambiguous: the member has left the club, or they staff the team rather than play in it. It also never removes somebody’s last group, and skips anyone it cannot identify with certainty rather than guessing at a name.',
        ],
      },
    ],
  },
  {
    version: '1.82.0',
    date: '13.08.2026',
    sections: [
      {
        title: 'See at a glance which duty slots nobody has taken',
        items: [
          'The scorer assignment page has a new Overview tab. It lists the season’s duties one row per slot — which team is on it, and who from that team has signed up — so "is this game actually covered?" is answerable in one place, instead of from the assignment table and the scorer page together. It shows the duties as they stand today, not a plan that has not been rolled out yet.',
          'One checkbox reduces it to the gaps. "Only show empty spots" hides every slot somebody has already taken, leaving just the duties still to be filled, with a count above the list. Upcoming games are shown by default; past ones can be included when you want to look back over the season.',
          'The list downloads as Excel exactly as shown, filter included — a ready-made list to hand to a coach or paste into a message, with the open slots highlighted.',
        ],
      },
    ],
  },
  {
    version: '1.81.0',
    date: '13.08.2026',
    sections: [
      {
        title: 'Transfers now cross-checks Swiss Volley’s own records',
        items: [
          'The transfers page shows where Swiss Volley records a different federation of origin than we do. This matters in both directions. For some players the club was preparing an international transfer that may not be needed at all, because Swiss Volley already counts them as Swiss. For others it is the other way round: our record says Switzerland and Swiss Volley’s does not, and those are the ones nobody was chasing. Nothing is changed automatically — an administrator decides whether to correct our record or ask Swiss Volley to correct theirs.',
          'Players who hold a club licence but are on no team roster no longer fall off the list. They were counted in a footnote and worked by nobody. They now appear like anyone else, marked "Licensed, not on a roster", so the missing roster entry stays visible as something to fix rather than quietly disappearing.',
        ],
      },
    ],
  },
  {
    version: '1.80.2',
    date: '12.08.2026',
    sections: [
      {
        title: 'Calendar subscriptions that had gone quiet work again',
        items: [
          'A subscribed calendar stopped receiving anything after the season changed. If you added Wiedisync to your phone or computer calendar, the link pointed at your team as it existed that season — so once the club moved to the new season, the calendar kept working but never showed another training or game, with nothing to tell you. Existing links now follow your team into the new season on their own. You do not need to re-subscribe.',
        ],
      },
      {
        title: 'Fixes you should not have to think about',
        items: [
          'People are no longer excluded from the duty lists by an old guest entry. Being marked a guest on any team in any past season quietly removed someone from every scorer and scoreboard picker, and it never wore off.',
          'Attendance percentages on a player’s profile were showing 0%. The statistics were being measured over a period that had not started yet, so nothing counted. They now cover the season so far, up to today.',
          'Coaches and teammates only see people from current teams. Access to teammates’ absences and answers, and coaches’ access to their players’ details and their team’s trainings and events, followed "was ever on a team with me" instead of "is on my team now". It is limited to current teams now; nobody loses access to anyone they currently play with or coach.',
          'Several places disagreed about when a new season starts. The team season dropdown switched over a month before everything else, so for all of May the current season was missing from it. Everything now uses the same date.',
        ],
      },
    ],
  },
  {
    version: '1.80.1',
    date: '12.08.2026',
    sections: [
      {
        title: 'The J+S export was missing every participant',
        items: [
          'Jugend+Sport exports contained the leaders and nobody else. The export asked for the season you picked but looked it up against this season’s teams, and the two never matched — so every activity and attendance CSV came out with the coaches listed and not a single participant, with nothing on screen to say anything was wrong. Both now find the right season’s squad. The activity lists were short for the same reason and are now complete. If an export ever does come back with no participants again, it says so instead of downloading quietly.',
        ],
      },
      {
        title: 'Last season’s teams stopped following people around',
        items: [
          'People were shown with teams they no longer play for. A player who moved from D2 to D1 was listed as "D1, D2", because a team change adds the new team without ever putting the old one away. Team names now show the current season only. Which sport someone plays is still worked out from their whole history, so nobody disappears from a list because of this.',
          'Coaches and teammates could still see people from past seasons. Access to a teammate’s absences and match responses, and a coach’s access to their players’ contact details, was granted by "has ever been on a team with me" rather than "is on my team now" — so it grew every season and never shrank. It is now limited to current teams. Nobody loses access to anyone they currently play with or coach.',
          'A team change no longer briefly logs you out of your own teams. For a day or so after the club rolled over to the new season, the app could think you had no teams at all — hiding the Yes/No buttons on trainings and games and emptying your team list until the rollover finished. Your teams are now read in a way that cannot fall into that gap.',
        ],
      },
    ],
  },
  {
    version: '1.80.0',
    date: '11.08.2026',
    sections: [
      {
        title: 'Find one datapoint instead of hunting for it',
        items: [
          'Search for a field, not just a person. The data explorer has a new Datapoint box next to the search. Type "AHV", "licence" or "Geburtsdatum" and pick the field you mean — the page then shows you that field and nothing else, for whichever member you open. It searches all ~110 columns by their English name, their German name and the database column, so "Lizenz" and "licence" both find the licence flags.',
          'It works in the table too. Focusing a datapoint pins it as a column right next to the name, so you can read it down the whole club at a glance. Your own saved columns are untouched — clear the focus and the table is exactly as you left it.',
          'Empty fields still show up when you ask for them. Searching for a field used to be pointless if the member had no value in it, because empty fields are hidden by default. A focused datapoint always appears, so you can see that it is empty — and fill it in.',
        ],
      },
      {
        title: 'Sport admins can see their members’ full record again',
        items: [
          'Birthdates and AHV numbers were being hidden from sport admins. A privacy rule meant for members’ profiles was also applied to the volleyball and basketball admins, so birthdates read as blank for almost every member and AHV numbers for all of them. Sport admins administer their sport’s register and need both — for age categories, the scorer-licence surcharge and licence paperwork — so they now see those members’ records as they are. The volleyball admin sees the volleyball section and the basketball admin the basketball one; each still sees the other section the way any member does. Members who belong to the club rather than to one sport stay visible to both. Coaches, team responsibles and everyone else are unchanged.',
        ],
      },
    ],
  },
  {
    version: '1.79.0',
    date: '11.08.2026',
    sections: [
      {
        title: 'Invite people who are not in the club',
        items: [
          'An event can now have a public signup link. Open an event, create the link, and anyone you send it to can sign up \u2014 no Wiedisync account, no app, nothing to install. They see the event, fill in their name, and they are on the list. Useful for a tournament, a Vereinsanlass, or bringing friends and family to something.',
          'You stay in control of the link. You can replace it, which makes the old one stop working immediately if it ends up somewhere you did not intend, or switch it off entirely. Turning it off keeps everyone who already signed up.',
          'Guest signups appear alongside member ones, so there is one place to see who is coming.',
          'If you are logged in, the link takes you into the app instead. Signing up as a guest would leave you off the team list, so members are sent to the event itself, where the normal Yes/No buttons count you properly.',
        ],
      },
      {
        title: 'Also in this release',
        items: [
          'The event window reads more clearly. The title now has its own line instead of being squeezed next to the buttons, the event type sits on its own row, and invited teams are listed as text rather than a wall of coloured tags.',
          'Fewer things appearing after the page has loaded. The home page used to reveal itself before the events section had arrived, and the games page before its team filter \u2014 both now wait, so the page appears complete in one go.',
        ],
      },
    ],
  },
  {
    version: '1.78.0',
    date: '11.08.2026',
    sections: [
      {
        title: 'Share a link to any event, training or game',
        items: [
          'You can now send someone straight to an event. Every event, training and game has a share button that copies a link opening that exact item in Wiedisync — so "you can sign up for this, here you go" is one message, instead of "open the app, go to Events, scroll down to Saturday". On a phone it opens your normal share sheet, so it goes straight into WhatsApp or a mail.',
          'The link still works when you are not logged in. Following one while signed out used to take you to the login screen and then dump you on the home page, with no idea what you had been sent. It now takes you to the login screen and straight on to the event.',
          'Notifications open the thing they are about. Tapping a notification used to leave you on the list page — often filtered so the item it was telling you about was not even on screen. It now opens the item itself.',
          'A link only works for people who could already see it. Sending a team\'s training link to somebody outside that team does nothing, and the link never gives away what it pointed at.',
        ],
      },
    ],
  },
  {
    version: '1.77.0',
    date: '10.08.2026',
    sections: [
      {
        title: 'Security and privacy hardening',
        items: [
          'A platform-wide security review. Most of it you will never see — permission scopes, audit trails, guards on internal endpoints — but these parts affect you directly.',
          'Your contact opt-out is now actually enforced. If you had hidden your phone number or email address, the club\'s duty and scorer screens were still receiving them and simply choosing not to display them. The server now withholds them outright.',
          'Nobody can look up a child\'s team from an email address. Checking whether an address already has an account returned the team names attached to it — and team names carry an age (MU10, DU14). They are no longer returned for anyone under 18.',
          'Logging out now clears your identity documents from the device. If you had opened encrypted ID documents, the key and the documents stayed in the browser after logout. On a shared computer the next person could still open them. Logging out now wipes both.',
        ],
      },
      {
        title: 'Fixed',
        items: [
          '"Absent on Mondays" showed on the wrong day abroad. Weekly absences were matched against your device\'s calendar day, so travelling west of Switzerland shifted them by one.',
          'A player profile could show 0/0 attendance. One open-ended weekly absence removed every session from the count, so an actively training player\'s profile read 0/0 with dashes instead of percentages.',
          'You can see your own fee category again. Your profile showed a dash where your membership category should be — the field was never actually being sent to you. It is visible to you and to the treasurer, and to nobody else.',
          'Invoices were missing their date, due date and breakdown. Membership invoices went out without an invoice date, a payment deadline, an addressee on the payment slip, or the itemised lines — a surcharge showed only as one combined total.',
        ],
      },
    ],
  },
  {
    version: '1.76.1',
    date: '10.08.2026',
    sections: [
      {
        title: 'Bug fixes',
        items: [
          'The last month-first date. The member explorer\'s date columns — birthdate, Eintritt, Austritt — still opened the browser\'s own date box when you clicked one to edit it, the single place last version\'s date sweep missed. They now open the club\'s calendar and read dd.mm.yyyy like everywhere else.',
          'Creating an event left the dialog open. Saving a new event kept the dialog on screen, sometimes for minutes, because it waited for every invitation email to go out before closing — with the Save button already back to normal, so it looked like nothing had happened and invited a second click. It now saves the event, closes, and sends the invitations in the background: you get a note that they are on their way, and a warning if they fail.',
        ],
      },
    ],
  },
  {
    version: '1.76.0',
    date: '10.08.2026',
    sections: [
      {
        title: 'Your licence status, on your profile',
        items: [
          'You can now see where your licence stands. Your profile shows a licence status for the current season — No licence, To be ordered, Ordered, Finalized or Licenced — so "has my licence been sorted out?" has an answer you can look up instead of asking. It is read-only: the club sets it, and Licenced specifically means your federation confirmed it, not that somebody thinks it is done. If it looks wrong, tell your coach.',
          'You are told when it changes. Every move sends you a notification and a push, in your language.',
          'It resets when the season turns over. A licence is issued for one season, so on 1 June everyone starts again at No licence and is moved back up as the federation confirms this season\'s licences. Last season\'s green tick can never quietly stand in for this season\'s.',
          'For admins: it is editable in two places. The member explorer has it as a dropdown with its own filter — "show me everyone still to be ordered" is one click — and newly approved registrations carry the five states as buttons, right where you are already looking at the new member. Swiss Volley and Basketplan fill in Licenced automatically once they confirm a licence; they never overwrite the steps you set by hand.',
        ],
      },
      {
        title: 'Dates are Swiss everywhere',
        items: [
          'A birthdate could read 05/10/2026. Date fields you type into — an applicant\'s birthdate on the registrations screen, and the basketball scheduling dates — were drawn by the browser, so anyone whose browser was set to English saw American month-first dates. That is worse than untidy: 05.10 and 10.05 are both real dates and nothing on the screen told you which one you were looking at. Every date field in the app now shows dd.mm.yyyy and opens the club\'s own calendar, whatever language you use it in.',
        ],
      },
    ],
  },
  {
    version: '1.75.1',
    date: '10.08.2026',
    sections: [
      {
        title: 'Forgot password works again',
        items: [
          '"Forgot password" could not reset a password. It sent you an 8-digit code, took the code, asked for a new password — and then said the link was invalid or expired. There was no link and nothing had expired: the code path is only able to set a first password, so for anyone who already had one it refused at the last step, and the message named the wrong cause. People read it as a broken email and requested code after code. Forgot password now emails you a reset link instead, which works whether or not you have a password already. If you have never set one, "Use a code instead" is one click below.',
          'The "Reset password" button on your own profile said it had failed. It reported an error every time even though the email had already been sent — so the mail arrived while the screen said it had not.',
          'Resetting while still signed in changed the wrong account. If you were already logged in on that browser, opening a reset link set the password of the account that was signed in and quietly ignored the link — so on a shared computer, following someone else\'s reset email changed your own password instead of theirs. The app then kept running on a login that had just been invalidated, so the next page filled with errors until you signed in again. A reset now always acts on the account the link or the code names, and signs the browser out cleanly when it is done.',
        ],
      },
    ],
  },
  {
    version: '1.75.0',
    date: '10.08.2026',
    sections: [
      {
        title: "A member's fee, in one place",
        items: [
          'The membership fee category moved to Finance & billing, and brought the amount with it. The category used to sit under Membership on its own, naming a rate but never the money — "why is this member billed CHF 310?" meant knowing the club\'s fee table, the CHF 100 scorer-licence rule and the age cut-off by heart. Finance & billing now shows the Beitrag amount right under the category, itemised: the base, the scorer-licence surcharge, the guest reduction and any discount, adding up to the total, and it says whether the base came from this season\'s rate table or the fallback list.',
          'A fee can now be set for one person without touching anybody else. Three fields — base, scorer-licence surcharge and discount, plus the wording that appears on the invoice — take a value for that member only. Leave them empty and the fee is worked out exactly as before; enter one and it is used everywhere the club bills, both the invoice run and the club register. Waiving the CHF 100 surcharge, which used to be done by writing the amount off after the invoice had already gone out, is now entering a 0. Nobody\'s fee changed: every member starts with no override.',
          'PDF previews were blocked on the live site. Registration documents, form uploads, receipts, mailbox attachments and ID scans all opened as an empty box — the browser was refusing to display them. Fixed; pictures were never affected, which is why it looked like a PDF problem.',
        ],
      },
    ],
  },
  {
    version: '1.74.0',
    date: '10.08.2026',
    sections: [
      {
        title: 'The member explorer opens on what matters',
        items: [
          'A member record no longer opens as 95 field cards. Fields with nothing in them, and the machine-owned ones — audit stamps, sync bookkeeping, encryption keys — are now hidden to start with, so a record opens on roughly half as many. Two buttons in the header bring either set back whenever you need it, and your choice is remembered. Editing always shows the blank fields again, so nothing ever becomes impossible to fill in.',
          'The "Nationality (ClubDesk spelling)" field showed the wrong spelling. It is there to show the exact word written into the club register — "Schweiz" — but it was being translated into the language of whoever was looking, so an English session read "Switzerland" and there was no way to see what the register would actually receive. It now shows the real value.',
        ],
      },
    ],
  },
  {
    version: '1.73.0',
    date: '10.08.2026',
    sections: [
      {
        title: 'Documents open where you are',
        items: [
          'A PDF now opens inside the app instead of sending you somewhere else. Registration documents, invoice attachments, expense receipts, form uploads and mailbox attachments used to hand you a new browser tab — or, for receipts and mail attachments, drop a file into your Downloads folder — just so you could read them. They now open in a window over the page, with the document itself on screen. Opening in a new tab and downloading are both still one click away.',
          'Photos and PDFs behave the same way. Whatever was uploaded, the same window shows it, so there is no longer a rule to remember about which kind of file previews and which kind does not.',
          'An ID saved as a PDF could not be viewed at all. Both the identity document on your own profile and the ID deck a coach opens at the match table only ever tried to show a picture, so a member who had uploaded a PDF scan showed a broken image to themselves and to the referee. Those now open properly.',
        ],
      },
    ],
  },
  {
    version: '1.72.0',
    date: '08.08.2026',
    sections: [
      {
        title: 'Mixed teams can take girls and boys separately',
        items: [
          'A mixed team fills up per gender, and "open for new players" could not say so. U8 and U10 are mixed, but the squad has room for girls and not boys, or the other way round — and the single switch either invited everyone or nobody. Mixed teams now have two more switches under it, one per gender.',
          'The club website acts on them. With only one of the two on, the team\'s card on the Nachwuchs page splits in half: the gender being taken gets the green badge and the contact form, the other gets the "Team voll" badge and the waiting list. Turning both on — or leaving both off, which is where every team starts — shows the single "open for new players" row exactly as before, so nothing changes until a coach opts in.',
          'Only mixed teams see the switches; a girls\' or boys\' team is unaffected.',
        ],
      },
    ],
  },
  {
    version: '1.71.0',
    date: '06.08.2026',
    sections: [
      {
        title: 'The member data explorer, rebuilt',
        items: [
          'Every field now has a real name and a real home. The explorer showed the raw database column name for anything it had not been taught about, and dropped those fields into an unnamed pile at the bottom. All 100 fields of a member record are now labelled in plain language and grouped by what they are for — identity, contact, membership, playing and coaching, association admin, roles, finance, privacy, notifications, ClubDesk, transfer, and the machine-owned ones last.',
          'Fields you cannot edit now say why. A locked field used to give no reason, so the only way to find out was to ask. Each one now names what writes it — a Swiss Volley or Basketplan sync, a database rule, or the app itself — so it is clear whether the value is wrong or simply not yours to change here.',
          'The right keyboard for the right field. A phone number is entered with a country prefix picker and is tidied into the club\'s standard format as you leave the field; an AHV number gets its dots and is checked; postal code and jersey number open a number pad; a profile photo is picked and previewed rather than typed as a code; a team is chosen from a searchable list rather than by its ID.',
          'Only the sport the member actually plays is shown. Licence and official fields for both sports were shown to everyone, so half of them were never relevant. The explorer now works out the member\'s sport from their teams — including coaches, who have no roster entry — and hides the other sport behind a toggle in case you need it.',
          'Association admin is one place. Swiss Volley and Basketplan details now sit together under one heading instead of the old "Address & Swiss Volley admin" grouping, which had no room for basketball at all.',
          'Teams can be changed from the member\'s page. A member\'s teams were read-only here and had to be edited elsewhere; they are now a multi-select on the record itself.',
          'Secrets are never shown. Encryption keys and calendar tokens now read only as "Set" or "Not set" — the value itself is no longer sent to the page.',
        ],
      },
      {
        title: 'Club mailbox: merge fields you can see working',
        items: [
          'A recognised field turns blue as you type it. “{{first_name}}” in the message body is now highlighted the moment it is recognised, so there is no doubt left about whether it will be replaced or sent to 117 people exactly as written. The subject line, which cannot colour its own text, lists its fields underneath instead.',
          'A field that is not recognised is struck through in red, and named again under the editor. This is the case that actually bites: “{{firstname}}” without the underscore is not a field, and until now nothing said so — it simply arrived in the inbox as written.',
        ],
      },
      {
        title: 'Removing a member, safely',
        items: [
          'Membership and app access can be switched off from the member\'s page, separately — someone can stop being a member while keeping their login, or the other way round.',
          'A record can now be deleted outright, and the app shows you what goes with it first. Before anything happens you get a list of everything attached — attendances, absences, fines, invoices, team entries, the login — separated into what will be deleted along with it and what will block the deletion until it is dealt with. Only then, after typing DELETE, does it go ahead.',
          'The same applies to events, trainings and games.',
          'Deleting a member now also removes their login, which previously stayed behind and could still sign in.',
          'You cannot delete yourself, and only a full administrator can remove another administrator or a board member. A section administrator can only remove people in their own sport.',
        ],
      },
    ],
  },
  {
    version: '1.70.0',
    date: '06.08.2026',
    sections: [
      {
        title: 'Club mailbox: paste a list of addresses',
        items: [
          'Recipients are now chips. Paste a whole column of addresses into To, Cc or Bcc and each one becomes its own removable chip — one per line, per comma or per semicolon, so a list copied out of a spreadsheet or another mail client no longer has to be tidied up by hand first.',
          'Addresses that carry a name are read correctly. “Anna Muster <anna@example.ch>” was previously discarded without a word: the send only ever accepted a bare address, so a recipient pasted in that form silently never received the mail. The name is now stripped off and the address kept.',
          'An address that cannot be read is shown in red and blocks the send instead of being dropped on the way out. Duplicates are merged, so the same person pasted twice gets one copy.',
          'Enter, Tab, comma and semicolon finish the address you are typing; Backspace on an empty field takes the last chip back for editing.',
          'The group send takes a pasted list too. “Email a group” could only reach an audience the app already knows — a team, a role, a season. A hand-curated list out of a spreadsheet is none of those, and the only way to mail one was to expand a large audience and delete everyone else. You can now paste the addresses straight in: each is matched to the person behind it, and the send treats them exactly like any other audience — one message each rather than one message with everyone’s address in the header, with names filled in and anyone who has unsubscribed left out. It tells you before you send how many were recognised and names the ones that were not.',
          'Recipients are listed by surname, and you choose where a pasted list goes. A pasted column arrives in whatever order the spreadsheet had it, which is not an order you can check against the club register — the names now sort by surname, and anyone we only hold an address for is shown as that address, grouped at the end where they are easy to spot. When you paste, you pick whether the list becomes recipients (one message each, names filled in, unsubscribed members left out) or a Cc / Bcc copy (one shared message, and the app now says so and stops you before an oversized copy is refused by the mail service).',
          'More merge fields, and a preview of what each person will actually receive. Besides the first and last name you can now drop the full name, email address, fee category, membership fee and team into the subject or the body — and the English field names always worked, but the tip only ever showed the German ones, so in an English app the feature looked German-only. A new Preview button renders the message as three real recipients would receive it, and warns when a field would come out blank for some of them — so a sentence like “your fee is CHF …” cannot go out with a hole in it for the members nobody has priced yet.',
        ],
      },
      {
        title: 'Email wording is now yours to change',
        items: [
          'The text of the emails the club sends to people who register can be edited in the app, under Email templates. Until now every word lived in the code and changing one meant a deployment, so the wording was effectively frozen and out of reach of the people who actually write to parents.',
          'Each language is edited separately, and a preview shows the message exactly as the recipient will see it — including changes you have not saved yet.',
          'Emptying a box puts the original wording back rather than sending an email with a gap in it, and the message cannot be saved without the part that lists the missing documents. A mistake in an email that goes to families should not be possible to save, let alone send.',
          'A new Sent tab keeps every email the club has sent from a template, exactly as it was received. Because the wording can now change, reading today’s template would no longer tell you what someone was actually told in August.',
          'Replies now reach the club. The emails are sent from a no-reply address while the text invited people to reply, so an answer went nowhere; replies are now directed to kontakt@kscw.ch.',
        ],
      },
    ],
  },
  {
    version: '1.69.0',
    date: '06.08.2026',
    sections: [
      {
        title: 'Registrations: asking for documents we lost',
        items: [
          'An approved registration can now be asked for its missing documents. Two upload faults in July destroyed or never stored the Swiss Basketball paperwork for seven registrations, and the families had no way of knowing — the registration looked approved and finished from their side.',
          'The request does not reopen the registration. The person stays a member, keeps their team and their ClubDesk entry; only the documents are asked for. Reopening would have re-run the whole approval — a second welcome email, a second ClubDesk contact — for something that was never their mistake.',
          'The email lists only what is actually missing, in the language the person registered in, and the link it carries already knows who they are. A Swiss junior is asked for three documents, a foreign one for five, and someone who only lacks the two declarations is asked for two.',
          'Documents already on file cannot be overwritten by the upload page, so a re-send can never quietly replace something that was already checked.',
        ],
      },
    ],
  },
  {
    version: '1.68.0',
    date: '05.08.2026',
    sections: [
      {
        title: 'Basketball scheduling',
        items: [
          'Spielplaner can now open the basketball scheduling pages. The volleyball routes have always let a Spielplaner in; the basketball ones only ever accepted a basketball admin, so anyone given the Spielplaner role found the link simply did not work — and it then sent them to the volleyball planner instead of saying why. It now says why.',
          'A team’s available dates now cover its own season. Every team was being offered the junior schedule, which ends on 13.12.2026 — so the two teams that play into May were declaring barely a third of the weekends the association asks about. The autumn and spring closures, Sport and Easter holidays included, are in as well.',
          'Dates where the halls are taken no longer show up blank. A Saturday with volleyball in all three halls rendered as an empty box with no explanation; it now names the reason — volleyball, a hall closure, a holiday or a club blackout.',
          'A volleyball match in the afternoon no longer blocks the whole day. Occupancy is worked out by the hour, so an evening basketball game in the same hall is offered normally, with the changeover time between the two respected.',
          'The calendar is on the planning page itself, since away games can be placed almost anywhere and the two are read together.',
          'Each team can carry its own rules — preferred start time, which days, which hall, who it must not clash with and who it should play alongside — and the planner proposes dates from them, showing why each one ranks where it does.',
          'Opponent clubs can be sent their own link, one per club, where they see our available dates and reply. The same idea as the volleyball opponent links, adapted to how basketball is scheduled.',
        ],
      },
    ],
  },
  {
    version: '1.67.0',
    date: '05.08.2026',
    sections: [
      {
        title: 'Hall finder: export to Excel',
        items: [
          'A search result can now be taken away as a spreadsheet. The table shows four of nineteen fields on a phone — the address, postcode, district, quarter, school district and caretaker contact are all hidden, and those are exactly what you need to actually chase a hall. The export carries every field, one row per hall.',
          'Hall dimensions come through as numbers, not just as the city’s “45,00 x 27,00 x 7,00 m” text, so you can sort or filter by length and find the halls that fit a full court.',
          'The search itself travels with the file — the weekdays, time, minimum duration and district you searched for, the season, and the date the availability data is from. A list of “free halls” with no filter and no date is one nobody can act on a fortnight later.',
        ],
      },
      {
        title: 'International transfers: checking the FIVB index when you need it',
        items: [
          '“Check VIS now” asks FIVB there and then. The check used to run once a month, so for thirty days out of thirty-one the page showed a fixed answer and the Refresh button could only reload it — which read as though Refresh were broken. It now also runs automatically every week rather than monthly.',
          'The page says how old the VIS numbers are, and the two buttons now explain which one re-reads our own data and which one goes and asks FIVB.',
          'A player already in the index is no longer reported as missing because of her name. Where a middle name or a compound surname sat on the other side of the first-name/surname split, the match failed and the player looked absent from a register she was in all along.',
        ],
      },
    ],
  },
  {
    version: '1.66.0',
    date: '05.08.2026',
    sections: [
      {
        title: 'Coaching qualifications and officials’ licences',
        items: [
          'Basketball coaches can now record their qualification. The profile only offered the volleyball ladder (Trainer C / B / A), so a Trainer 1 or Trainer 2 had nothing to select and the club’s register kept the answer to itself. The list now shows the rungs for your own sport, with J+S available to everyone.',
          'Three referees were missing their licence in Wiedisync. Their names are spelled slightly differently in Basketplan, so the nightly import had never matched them and they were absent from the officials list despite holding a current licence. Their licence numbers are now on file, which is what stops it happening again.',
        ],
      },
    ],
  },
  {
    version: '1.65.0',
    date: '05.08.2026',
    sections: [
      {
        title: 'Fixed: setting a new password',
        items: [
          'Choosing a new password works again. The form accepted any password of 8 characters or more, but the server also requires a number or a symbol — so a password made only of letters was rejected after you pressed save, and the app blamed the reset link instead of the password. At least one member spent a quarter of an hour requesting fresh links to fix a link that was never broken.',
          'The rules are now written under the password field, and if a password is turned down the app says which rule it missed, in your language.',
          'The "Set password" link in the reset email now opens the password form. Until now it landed you back at the code-by-email screen, so the mail was effectively a dead end.',
          'If we cannot find an account for the address you typed, the app now suggests trying the address the club has on file for you. Members whose personal address differs from their club one were told no account existed and pointed at signing up, which would have created a duplicate.',
        ],
      },
    ],
  },
  {
    version: '1.64.0',
    date: '04.08.2026',
    sections: [
      {
        title: 'Club emails: picking who gets them',
        items: [
          'Picking two teams now means both of them. Choosing D1 and D2 used to ask for the people who are on both rosters — almost nobody — so a mail meant for 39 players would have reached a handful. Anything picked from the same row is now added together, while picking across rows still narrows: Volleyball plus Coaches is still the volleyball coaches.',
          'Every option shows what it would make the audience, live. Choose Volleyball and the Coaches count drops from 30 to 15 in front of you, so you can see what a filter costs before committing to it.',
          'You can now write to members by type — active, passive, honorary, gap year — or to guest players, alongside the existing “all members”.',
          'Scorers, referees and officials now mean the people who actually do the job for the club, taken from the ClubDesk groups, rather than everyone who happens to hold the licence. The basketball officials list alone was 31 people too broad.',
          'The composer opens on the current season, and the season sits next to the options it applies to.',
        ],
      },
    ],
  },
  {
    version: '1.63.3',
    date: '04.08.2026',
    sections: [
      {
        title: 'Fixed: seeing who has answered a game',
        items: [
          'Coaches, team responsibles and admins can reach a game’s attendance list again. For them the roster button opened the match sheet and nothing else, so the people most likely to ask who has replied had no way to see it from the game. There are now two buttons — “Match sheet” and “View roster” — and the first one finally says what it does. Everyone else still has the single button, unchanged.',
        ],
      },
    ],
  },
  {
    version: '1.63.2',
    date: '04.08.2026',
    sections: [
      {
        title: 'Fixed: saying whether you are coming to a game',
        items: [
          'Players called up from another team can now answer. Opening a game to another team put the fixture on all their calendars but gave them no Yes / Maybe / No buttons, so nobody could actually say whether they were coming. Their replies now count towards the game’s tally like everyone else’s.',
          'The Yes / Maybe / No buttons are back on the games list. Since 10.06 they only appeared once you opened a game, so answering straight from the list was impossible. The same fault also meant a coach’s reply was counted as a player’s instead of being filed under staff, and that players who may not play league games were not held back.',
          'Attendance counts appear together with the rest of a game, instead of a moment later, and no longer nudge everything below them as they arrive.',
        ],
      },
    ],
  },
  {
    version: '1.63.1',
    date: '04.08.2026',
    sections: [
      {
        title: 'Fixed: uploading your ID from a phone',
        items: [
          'Uploading an identity document works again. Tapping "Upload document" opened the camera or photo library but then bounced you back to your profile, and the photo you took was silently discarded — nothing was saved and no error was shown. Every attempt since 28.07 failed this way.',
          'You can now crop and rotate the photo before it is saved. A phone shot of an ID is usually sideways, or a small card on a big table; you can straighten it, zoom in and trim away the background, with presets for an ID card, landscape or portrait.',
          'As before, the picture is encrypted on your own device — the club still cannot read it, and now only the part you kept is stored at all.',
        ],
      },
    ],
  },
  {
    version: '1.63.0',
    date: '03.08.2026',
    sections: [
      {
        title: 'Improved: choosing who a club email goes to',
        items: [
          'Audiences are now clickable chips showing how many people each one reaches, instead of a dropdown you had to open to see what existed.',
          'You can combine them \u2014 pick "All coaches" and two teams and it goes out once to everyone, with nobody receiving it twice.',
          'Sections and teams are now separate choices. "Volleyball section" reaches everyone in the section including coaches and staff; "Volleyball players" reaches only those on a team right now.',
          'Former members can be reached too, for the rare club-wide announcement that warrants it.',
          'Addresses that bounce, or where someone marks the email as spam, are now remembered and skipped automatically \u2014 which protects delivery of everything else the club sends, including password reset emails.',
        ],
      },
    ],
  },
  {
    version: '1.62.0',
    date: '03.08.2026',
    sections: [
      {
        title: 'New: the club can email a whole group at once',
        items: [
          'The club mailbox can now write to a whole group \u2014 a team, all coaches, all scorers, all referees, the board, or every member \u2014 instead of pasting addresses together by hand.',
          'Before anything is sent you see exactly how many people will receive it, and why anyone is left out (no address on file, unsubscribed, or sharing an address with someone else already on the list).',
          'Everyone gets their own copy, so nobody sees anyone else\u2019s address, and replies come back to the club mailbox where the whole board can follow them. You can attach files, and write {{vorname}} to greet each person by name.',
          'Group emails now reach members who have never signed in to Wiedisync. Previously a message to "all scorers" quietly went to only about two thirds of them, and to "all basketball referees" to barely a quarter.',
        ],
      },
    ],
  },
  {
    version: '1.61.0',
    date: '03.08.2026',
    sections: [
      {
        title: 'Improved: the live scoreboard page',
        items: [
          'The hall scoreboard now actually feeds the page. The board publishes every score change itself, so Live shows a real match without anyone doing anything \u2014 for volleyball, beach volleyball and basketball alike.',
          'A final screen when the match ends, naming the winner and the result, above the full board.',
          'Recent matches on the scoreboard are listed underneath, so the page is still worth opening once a match has finished.',
          'A "live now" link on the games page while a match is being scored, so you don\u2019t have to go looking for it.',
          "Small touch: the score gives a brief bump when a point lands (skipped if you've asked your device to reduce motion).",
        ],
      },
    ],
  },
  {
    version: '1.60.0',
    date: '03.08.2026',
    sections: [
      {
        title: 'New: follow a match live from the scoreboard',
        items: [
          "The hall's scoreboard now feeds a live page in the app. Open Live and you see the same score the LED board in the hall is showing, updating on its own every few seconds \u2014 no refreshing, and no need to be logged in, so you can share the link with family and friends.",
          'It works for volleyball, beach volleyball and basketball. Volleyball shows the points in the current set, sets won, timeouts, substitutions, who is serving and the scores of the sets already played; beach shows both players of a pair; basketball shows the running score, the quarter, team fouls with the bonus and the possession arrow.',
          'The page tells you what it is doing \u2014 whether it is live, finished, or waiting for a match to start.',
        ],
      },
    ],
  },
  {
    version: '1.59.0',
    date: '01.08.2026',
    sections: [
      {
        title: 'New: call up players from another team for a single game',
        items: [
          'A coach can now open one game to another team, or to individual players. A cup game filed under H1 can be opened to H3; a junior can be pulled up for one Saturday. The called-up players see the fixture on their home page, in their calendar and in their subscribed calendar file, and they answer yes/no/maybe there like any other game.',
          'They appear in the participation list with everyone else, marked with the team they were called up from, so the coach picks a squad from one list instead of two. Their jersey number for that game is set on the match sheet as usual, and they are carried onto the Volleymanager nomination list.',
          'Nothing about their team membership changes. The call-up is scoped to that one fixture: their trainings, absences, attendance figures and ClubDesk group are untouched, and it disappears when the game does.',
          'They get a notification when they are called up, and their reminders \u2014 the answer deadline and the "game tomorrow" nudge \u2014 work exactly as for the home team. If they mark themselves absent that day, their answer is withdrawn automatically.',
          'The coach is warned about clashes, not blocked: anyone already playing a game that day is flagged in the picker and in the summary, and the two coaches decide.',
          "Only the coach or team responsible of the game's own team can call players up, and closing a team call-up releases the players it brought while keeping anyone invited by name.",
        ],
      },
    ],
  },
  {
    version: '1.58.0',
    date: '01.08.2026',
    sections: [
      {
        title: 'Fixed: cancelled trainings and games looked like they were still on',
        items: [
          'A cancelled training now shows as cancelled on the calendar — struck through and dimmed, instead of looking exactly like one that is still happening. This was most confusing on a game day: the club automatically cancels a team\u2019s training when that team plays that evening, so the training was correctly called off in the system but the calendar still advertised it right next to the fixture. Opening it explains why ("Cancelled \u2014 game day"). The same applies to cancelled games and events, in every calendar view and in the "Next 7 days" strip on the home page.',
          'Exported calendar files (.ics) mark cancelled entries too, so they are also clear in Apple Calendar, Google Calendar and Outlook. The subscription link already did this.',
          'The home page no longer jumps while it loads. The "Next 7 days" strip appeared a moment after everything else and pushed the rest of the page down as it arrived; it now holds its place from the start.',
        ],
      },
    ],
  },
  {
    version: '1.57.0',
    date: '01.08.2026',
    sections: [
      {
        title: 'New: hall sizes and photos in the hall finder',
        items: [
          'Every hall in the hall finder now shows its size — length, width and ceiling height, exactly as the city publishes it. All 104 halls have one, so it is finally possible to tell a full-size sport hall from a small gymnastics room without opening the city website for each.',
          'A photo of the hall where the city has one on file (about half of them). Tap it to see it full size.',
        ],
      },
    ],
  },
  {
    version: '1.56.2',
    date: '30.07.2026',
    sections: [
      {
        title: 'Improved: participation exports (PDF, image and CSV)',
        items: [
          'Staff and waitlisted players no longer vanish from a filtered export. Exporting with a status filter on (e.g. "Confirmed") dropped every coach, team responsible and waitlisted player from the sheet, even though they were still listed on screen. The export now matches what the participation list shows; the filter narrows the roster only.',
          'The export header names the activity again. Opening the participation list from the events or trainings list produced a sheet headed "Participation" with nothing identifying it; it now carries the event or team name and date, in the header and in the file name.',
          'One guest column instead of two. "Guest" (is this a guest player) sat next to "Guests" (plus-ones) and read as a duplicate. A guest player is now marked in the name — like the coach, captain and team-responsible markers — and the remaining column is only about plus-ones.',
          'A Team column when the list covers several teams, with the rows grouped by team. Single-team lists are unchanged.',
        ],
      },
    ],
  },
  {
    version: '1.56.0',
    date: '30.07.2026',
    sections: [
      {
        title: 'Fixed: coaches\' answers on a multi-day event went missing',
        items: [
          'A coach or team responsible who is not on the team\'s player list could answer a multi-day event (the Trainingsweekend), and their answer was filed as a player\'s. The participation list showed them as "Not responded" while the count on the card treated them as one more player coming. Their answers now appear where they belong, and the "Coach present" figure counts people rather than days — a coach who said yes to both weekend days counted twice.',
          'On an event that invites several teams, only the first team was considered when deciding whether you answer as staff or as a player. A coach of the second team was filed as a player.',
        ],
      },
      {
        title: 'New: answer for the staff too',
        items: [
          'Coaches and team responsibles now have the same edit controls as everyone else in the participation list — including the "all days at once" answer on a multi-day event\'s Overall tab, per-day answers, and notes.',
        ],
      },
      {
        title: 'Fixed: rows cut in half in the PDF export',
        items: [
          'Exporting a participation list longer than one page split the last row of every page across the page break — the name on one page, the answer on the next. Pages now end between rows.',
        ],
      },
    ],
  },
  {
    version: '1.55.0',
    date: '29.07.2026',
    sections: [
      {
        title: 'New: answer for every day at once on a multi-day event',
        items: [
          'The "Overall" tab of a multi-day event\'s participation list is now editable. Setting a member to Yes / Maybe / No there applies it to every day at once, instead of opening each day\'s tab and repeating the same answer. Days that already disagree are brought in line; a member whose days genuinely differ starts from a blank dropdown rather than a guess, and their per-day notes are left alone unless you actually type one.',
        ],
      },
    ],
  },
  {
    version: '1.54.2',
    date: '29.07.2026',
    sections: [
      {
        title: 'Fixed: day-by-day answers on a multi-day event didn\'t stick',
        items: [
          'Setting a member\'s answer for a single day of a multi-day event (the Trainingsweekend and anything else with per-day responses) saved to nowhere — the roster kept showing "Not responded", and a second attempt failed with an error mentioning that a value "has to be unique". Answers now save to the day you picked.',
        ],
      },
    ],
  },
  {
    version: '1.54.1',
    date: '29.07.2026',
    sections: [
      {
        title: 'Fixed: saving an edit failed with a "has to be unique" error',
        items: [
          'Editing an existing event, form, hall slot or team\'s staff could fail to save, with an error mentioning that a value "has to be unique" — even when you had only changed something ordinary like a response deadline and hadn\'t touched the teams at all. Everything saves again.',
        ],
      },
    ],
  },
  {
    version: '1.54.0',
    date: '28.07.2026',
    sections: [
      {
        title: 'New: identity documents are watermarked when shown',
        items: [
          'Every identity document displayed before a game now carries a visible stamp burned into the image itself — club, purpose ("Spielkontrolle / match check"), who opened it and when. A screenshot keeps the stamp, so the document cannot pass as a clean copy anywhere else, and any leaked image is traceable to the audit-logged viewing.',
        ],
      },
      {
        title: 'Improved: showing IDs before a game',
        items: [
          '"Show IDs" now downloads the documents by itself if you haven\'t pre-downloaded them. The separate "Download for offline" button remains for preparing before you travel — halls often have no signal.',
          'If you open the dialog before the 45-minute window, the Show button now unlocks itself the moment the window opens (and closes itself at kickoff) — no more closing and reopening.',
        ],
      },
      {
        title: 'Changed: your identity document is managed in Edit profile',
        items: [
          'The encrypted identity-document section moved from the profile view to Edit profile, next to the other things you can change — and it now loads in one piece instead of flickering through loading states.',
        ],
      },
    ],
  },
  {
    version: '1.53.0',
    date: '28.07.2026',
    sections: [
      {
        title: 'New: complete your profile to use the app',
        items: [
          "The app now asks for your core contact details before you can continue: phone number, birthdate, address and nationality. The club is required to keep these in the member register, and until now coaches and staff were never asked for them at all. If your profile already has them (most members), you won't notice anything.",
          'Coaches and staff without a playing role are now recorded in the "Gratis" fee category automatically, so they appear correctly in the club register.',
        ],
      },
    ],
  },
  {
    version: '1.52.0',
    date: '28.07.2026',
    sections: [
      {
        title: "Improved: game days no longer show a training your team can't attend",
        items: [
          "Trainings on game days are cancelled automatically. When your team has a game — home or away — that day's training is taken off the calendar. If the game moves or is called off, the training comes back by itself; a coach can still reinstate a training and that decision sticks.",
          'Players in two teams are excused automatically: if your other team has a game that day, you are signed out of the training with a note naming the game (e.g. "Game H2"). Your own answers always win — explicit RSVPs are never overridden.',
        ],
      },
    ],
  },
  {
    version: '1.51.0',
    date: '27.07.2026',
    sections: [
      {
        title: 'Improved: the app now speaks French and Italian throughout',
        items: [
          'Nearly a thousand interface texts per language were still English for French and Italian users — the whole finance area, most of the member admin, the forms feature, the hall finder, the game-scheduling tools and many smaller corners. All of them are now properly translated, using the same club vocabulary as the existing translations.',
        ],
      },
    ],
  },
  {
    version: '1.50.0',
    date: '27.07.2026',
    sections: [
      {
        title: 'Removed: three unused features',
        items: [
          'Per-activity task checklists, game carpools and the admin saved-queries strip have been removed. None of them saw a single use across a full season. The fines page, hall-slot claims and referee expenses stay — they are expected to earn their keep when the 2026/27 season starts.',
        ],
      },
    ],
  },
  {
    version: '1.49.0',
    date: '27.07.2026',
    sections: [
      {
        title: 'Fixed: club-wide events were missing from the website and calendar feeds',
        items: [
          'Club-wide events — those open to everyone rather than tied to a team — had disappeared from kscw.ch and from subscribed calendars. They are back, and the underlying data problem can no longer recur.',
          'Cancelled events now disappear properly: the website no longer lists them, and subscribed calendars receive a cancellation so they vanish there too.',
        ],
      },
      {
        title: 'Fixed: a cancelled game stayed cancelled',
        items: [
          'A game cancelled in the app was silently put back on the calendar by the nightly league sync. A cancellation now sticks unless the league reports the game as played — and if a game genuinely is back on, everyone on the team gets a "Game back on" notification instead of it quietly reappearing.',
        ],
      },
      {
        title: 'Fixed: attendance counts and absence sign-out',
        items: [
          'Duplicate RSVPs could double-count members in attendance tallies, and RSVPs left over from deleted trainings inflated per-member statistics. Both are cleaned up and can no longer recur.',
          'An absence now also signs you out of club-wide events and events you were personally invited to — previously you could even be auto-signed-in while absent. Multi-day events are declined per day, matching how you sign up for them.',
        ],
      },
      {
        title: 'Improved: member admin and data integrity',
        items: [
          'The member admin form is now organized into collapsible sections (identity, address, licences, preferences, billing, …) instead of one flat 100-field list.',
          'The admin "Last online" column now actually shows when a member last logged in.',
          'A broad round of database hardening: proper cross-references throughout games, trainings, rosters and finance data, duplicate records merged, and faster admin audit pages.',
        ],
      },
    ],
  },
  {
    version: '1.48.0',
    date: '25.07.2026',
    sections: [
      {
        title: 'New: Hall finder — free city sport halls for the season',
        items: [
          'A new admin tool (Options → Hall finder) shows which City of Zürich sport halls have a free recurring training slot for the whole winter season, so you no longer have to check the city booking site hall by hall.',
          'Filter by weekday, earliest start, minimum duration, city district and hall type. By default it lists only halls that are free every week excluding school holidays; switch that off to also see halls that are free most weeks.',
          'Each result links straight to the city occupancy calendar and to a pre-filled reservation request. Availability is refreshed automatically every night.',
        ],
      },
    ],
  },
  {
    version: '1.47.0',
    date: '25.07.2026',
    sections: [
      {
        title: 'New: nationality is now a proper list, with flags',
        items: [
          'Pick every nationality you hold, not just one. The profile nationality field is a searchable list with flags — start typing a country or its two-letter code. Dual nationals can select both; the first one you pick is treated as your main one and is what the club register receives.',
          'It reads in your language. Previously the field held a German country name whatever language you used the app in.',
        ],
      },
      {
        title: 'New: federation of origin',
        items: [
          'A new profile field asks which national federation licensed you at age 14 — the definition Swiss Volley and the FIVB use, and the one that decides whether an international transfer is needed to play here. It is not necessarily where you first played.',
          '"None" is a real answer. If no national federation licensed you at 14 — for example if you only ever played recreational leagues such as Italy\'s CSI, UISP or PGS, which are not FIVB or FIBA members — choose it. That tells the club there is nothing to request, which a blank field cannot.',
          'The membership sign-up form asks the same two questions, so new members arrive with the answer already recorded.',
        ],
      },
      {
        title: 'New: Transfers page (club staff)',
        items: [
          'A per-sport view of international transfers, grouped by federation of origin, with a note field and a done marker. It also lists members whose nationality suggests the question has never been put to them.',
          'For volleyball it cross-checks Swiss Volley\'s licence data and flags two situations: someone marked done whose licence is not validated — meaning they are not yet eligible to play — and someone still marked pending whose licence has been validated, which usually means the certificate has already arrived.',
          'One prepared email per federation. A transfer cannot be requested until the player exists in the FIVB VIS index, so each federation group carries a single ready-to-send request listing everyone of theirs still missing from it, with name, date of birth and email. Copy it, or open it straight in your mail programme. It is always written in English — the working language of the FIVB — whatever language you read the app in.',
          'The federation\'s own contact address is on file for every country our members come from, taken from VIS, and shown once per group.',
          'Only members who are actually on a team appear. Anyone on no team is counted in the page header instead of filling the lists; add them to a team and they return.',
        ],
      },
      {
        title: 'Improved: officials licences distinguish OTN 1 and OTN 2',
        items: [
          'The basketball table-official licence now records the level, matching Swiss Basketball\'s own register, which has always kept the two apart.',
        ],
      },
    ],
  },
  {
    version: '1.46.1',
    date: '25.07.2026',
    sections: [
      {
        title: 'Fix: open-ended absences now sign you out reliably',
        items: [
          'An absence with no end date now signs you out of every training and game across its whole span — including sessions added to the calendar later — just like a dated absence does. Some open-ended absences (typically the long-term ones entered on a member\'s behalf) were being missed, so the person still showed as attending. This is independent of the "blocks game scheduling" switch, which only affects planning and never changes your own attendance.',
        ],
      },
    ],
  },
  {
    version: '1.46.0',
    date: '16.07.2026',
    sections: [
      {
        title: 'New: send club news to specific teams or roles',
        items: [
          'Club news can now be addressed to particular teams, or to people by what they do. Alongside "all members" and "one sport", you can pick specific teams — which reaches their players, coaches, team responsibles and captain — or target roles and functions: the board, coaches, captains, scorers, referees, finance, and so on. The email, the push and the in-app post all go to exactly that group, and nobody else sees the post.',
          'Every news email now asks you to confirm before it sends, and tells you who it is about to reach. Previously only the "all members" blast asked.',
        ],
      },
    ],
  },
  {
    version: '1.45.0',
    date: '15.07.2026',
    sections: [
      {
        title: 'New: guided tours for more of the app',
        items: [
          'The in-app guide now covers more areas. News, Fines, and the Calendar each have a short, tap-through walkthrough that points out the buttons and lists right on the page. Open Guide from the menu and pick a tour — a green tick marks the ones you have finished.',
        ],
      },
    ],
  },
  {
    version: '1.44.0',
    date: '15.07.2026',
    sections: [
      {
        title: 'New: go by the name you actually use',
        items: [
          'You can set a preferred display name in your profile. If people call you something other than your legal first name — Honza instead of Jan — set it once and the whole app shows it: rosters, RSVP lists, chat, absences, scheduling. Leave it empty to keep your first name.',
          'Official documents are unaffected. Match sheets, Volleymanager, ClubDesk, invoices and the public website always use your legal name — only the in-app display changes.',
        ],
      },
      {
        title: 'New: basketball scheduling prep',
        items: [
          'The scheduling app now has a Volleyball / Basketball toggle. Basketball is scheduled centrally by the association (ProBasket), so its section is a preparation view: for each team it shows which home dates (Fri/Sat/Sun) the KWI hall is free — with volleyball’s hall use, closures and blocked dates overlaid — and lets you record availability to bring to the planning meeting or the hall-availability form.',
        ],
      },
    ],
  },
  {
    version: '1.43.0',
    date: '14.07.2026',
    sections: [
      {
        title: 'New: the match sheet, on your phone',
        items: [
          'Coaches and team responsibles can now open the match sheet from a game, in the hours around kickoff, and hand the phone to the scorer. It is laid out the way the sheet is actually filled in: birthdate, number, then surname and first initial. The captain\u2019s number is circled, liberos appear again in their own block, and the officials are listed at the bottom.',
          'You can adjust it for that one game \u2014 change a number, move the captain\u2019s circle, flag a libero, or, in an emergency, add a player who turned up unnominated or strike out one who did not. None of this touches the player\u2019s normal shirt number, position, or the team\u2019s captain: it applies to that match only.',
          'Adding or removing a player is the only change that can disagree with Volleymanager, and it is the only one that raises a warning. Numbers, captain and libero do not exist on the Einsatzliste at all, so changing them cannot contradict it. If you do add or drop someone, Wiedisync tells you, in red, that the same change must also be made by hand in Volleymanager \u2014 it does not send it for you.',
        ],
      },
      {
        title: 'New: your ID, encrypted so that nobody here can read it',
        items: [
          'You can upload a photo of your ID in your profile, and your coaches can show it to a referee before a game. It is encrypted on your own device before it leaves it. The club cannot read it \u2014 not the committee, not the admins, not the server. Only you and the coaches and team responsibles of your teams hold a key to it.',
          'Coaches see them from 45 minutes before kickoff. They can download them beforehand, because halls usually have no signal, and the documents are removed from the phone again once the game starts. Every time someone opens an ID, it is recorded.',
          'This is real encryption, and it has a real consequence. There is no master key and no way for anyone at the club to recover your document. If you reset a forgotten password, your key is lost with it and you simply upload your ID again. Changing your password from inside the app is safe \u2014 it keeps your key.',
          'Only members who have logged in can have a document, because the key is made from your password. There is no way around that without the club being able to read your ID, which is the one thing this is for.',
        ],
      },
      {
        title: 'Fixed: away games were showing the wrong list',
        items: [
          'The Einsatzliste for away games was never being read. Wiedisync only ever looked at the home team\u2019s list, so for away games it quietly fell back to the RSVPs \u2014 which meant a nominated player who had not RSVP\u2019d was simply missing from the sheet, in the away hall, which is exactly where a referee is most likely to ask for it. Away games now show the real Einsatzliste, the same as home games.',
          'Officials are now listed with their role (coach, assistant coach 1, assistant coach 2) instead of as one anonymous list. Volleymanager knew this all along; Wiedisync was throwing it away.',
        ],
      },
    ],
  },
  {
    version: '1.42.0',
    date: '13.07.2026',
    sections: [
      {
        title: 'New: the Einsatzliste can file itself',
        items: [
          'Volleymanager’s Einsatzliste can now be filled in automatically from the RSVPs. About an hour before a game, Wiedisync takes everyone who confirmed, matches them to their Swiss Volley licence, enters them into the Einsatzliste in Volleymanager, and closes it. This works for away games too, not just home games.',
          'It is off by default, and you turn it on per team (Team settings → Game defaults), or per game if you want to override the team’s setting for one match.',
          'It will not close a list that Volleymanager is unhappy with. If Volleymanager warns that the list is too short or has no coach — the kind of thing the club can be fined for — Wiedisync enters the players but leaves the list open and tells you to check it. It never files a list you could be fined for without a human looking at it.',
          'Only players who hold a licence can be nominated, so anyone who confirmed but has no licence number on file is reported rather than quietly dropped.',
        ],
      },
    ],
  },
  {
    version: '1.41.0',
    date: '13.07.2026',
    sections: [
      {
        title: 'Fixed: the member list was empty when inviting people to an event',
        items: [
          'If you are a coach or a team responsible, creating an event now shows the full member list again. The invite picker was coming up empty — not because nobody matched, but because the app was not allowed to read one of the fields it was searching on, so the request was rejected and the list silently came back blank. No error was ever shown, which is why it looked like "no members found".',
        ],
      },
      {
        title: 'For admins: ClubDesk consistency check',
        items: [
          'The ClubDesk sync page now lists everything that has drifted between ClubDesk and Wiedisync, with an Excel worklist: members in no ClubDesk group, members missing their team’s group, coaches missing their coach group, people in a ClubDesk group but not on the roster, and members paying a playing fee while on no roster.',
          'Each team’s ClubDesk group is now stored on the team itself, so a new team can no longer be silently skipped by these checks.',
        ],
      },
    ],
  },
  {
    version: '1.40.0',
    date: '13.07.2026',
    sections: [
      {
        title: 'Data explorer: ClubDesk sync + registration files',
        items: [
          'New "ClubDesk sync" column — see at a glance whether each member matches the club register: In sync, Drift (a field differs), Pending push, Not linked, Stale link or Departed. Groupable, so you can pull up everyone who is out of step.',
          'New "Reg. files" column — the documents a member uploaded when they registered are kept after approval, and can now be opened straight from the grid.',
          'The column header row and the name column stay put while you scroll, so you always know which column you are looking at.',
          'More inline editing: sex and preferred language are now dropdowns, and scorer (VB) / Wiedisync active toggle with a click. Yes/no columns show a checkmark only when true, so the ones that are set stand out.',
        ],
      },
      {
        title: 'Your registration documents',
        items: [
          'Profile now has a "My documents" card. The ID and licence documents you uploaded when you registered are kept, and you can open them again any time. It only appears if you have documents.',
        ],
      },
    ],
  },
  {
    version: '1.39.0',
    date: '12.07.2026',
    sections: [
      {
        title: 'Data explorer: team view',
        items: [
          'The grid has a Members | Teams toggle — the team view lists every team with its roster, coach and team responsible as editable chips, plus in-place editing of team name, league and season.',
          'Nine more member columns: sport, scorer (VB), referee (VB/BB), officials licence, Wiedisync active, last online, and passive / honorary / former membership.',
          'Export, sorting, search and the column chooser work in both views.',
        ],
      },
    ],
  },
  {
    version: '1.38.0',
    date: '12.07.2026',
    sections: [
      {
        title: 'Club news in your notifications',
        items: [
          'Published announcements now appear in the notification bell for everyone in the announcement’s audience — tapping one opens the news page.',
        ],
      },
    ],
  },
  {
    version: '1.37.0',
    date: '12.07.2026',
    sections: [
      {
        title: 'Newsletter emails',
        items: [
          'Announcements can now be emailed in a newsletter layout — club masthead, the announcement image as a hero, a large headline and a call-to-action button.',
          'Emailed announcements can carry a reply-to address, so members’ replies reach a real mailbox instead of no-reply.',
        ],
      },
    ],
  },
  {
    version: '1.36.0',
    date: '12.07.2026',
    sections: [
      {
        title: 'Data explorer grid view',
        items: [
          'The Data explorer now has a spreadsheet mode (toggle in the header): a team rail with member counts next to a dense, sortable member table. Shows first / last name by default — add any of 19 columns via the column chooser.',
          'Sport admins and above edit cells in place — changes save field-by-field, and the Teams column adds or removes team memberships directly.',
          'Group rows by team, city, nationality, birth year and more; search across every column; export the current view to Excel or PDF.',
        ],
      },
      {
        title: 'Tidier admin menu',
        items: [
          'The Admin dropdown is organized into sections (Planning & halls, Game operations, Members & communication, Data & insights) on desktop and mobile.',
        ],
      },
    ],
  },
  {
    version: '1.35.0',
    date: '11.07.2026',
    sections: [
      {
        title: 'Your duties, everywhere',
        items: [
          'Your assigned scorer / scoreboard / referee duties now appear as a yellow reminder on the home page (from one week before until the game ends), as an entry in “My next appointments”, and on the Events page.',
          'Your duties are now automatically included in your calendar subscription — whatever you subscribe to, they ride along, no separate link needed.',
          'Pending duty hand-offs now show on the home page too, so you can accept or decline a delegated duty without opening the scorer page.',
        ],
      },
      {
        title: 'Emergency help at the hall',
        items: [
          'Within an hour of kick-off, an on-duty official can tap “Emergency: contact team leaders” to see the playing team’s coach / responsible phone and email and alert the club at once.',
          'The coach’s “report late” button now appears once an official is actually late — 29 minutes before the start for the scorer / referee, 14 for the scoreboard.',
        ],
      },
      {
        title: 'Automatic no-show fines',
        items: [
          'When a coach flags a scorer / official as late or absent via the emergency button, the CHF 50 duty fine is now issued to them automatically (using the team’s fine rules when configured).',
        ],
      },
    ],
  },
  {
    version: '1.34.1',
    date: '09.07.2026',
    sections: [
      {
        title: 'Participation export polish',
        items: [
          'Exporting a multi-day event roster (PNG / PDF / CSV) now shows each person’s answer per day instead of collapsing it to a single status. A single-day export is also labelled with the day.',
          'Fixed the position summary (“Outside hitter”, “Middle blocker”) wrapping mid-word in the export.',
          'A playing coach no longer appears a second time in the export’s staff list — they already show in the roster with a “(Coach)” badge.',
        ],
      },
    ],
  },
  {
    version: '1.34.0',
    date: '09.07.2026',
    sections: [
      {
        title: 'ClubDesk group checks in Data Health',
        items: [
          'Data Health now flags when Wiedisync team rosters and ClubDesk groups disagree: players missing their team’s ClubDesk group, people sitting in a ClubDesk group without being a current player, and ClubDesk groups with no matching team. ClubDesk groups can only be changed by hand, so these are surfaced for review — not auto-fixed.',
        ],
      },
    ],
  },
  {
    version: '1.33.0',
    date: '09.07.2026',
    sections: [
      {
        title: '“Staff only” position',
        items: [
          'Members who are staff and don’t play can now be marked “Staff only” instead of “Other” when choosing positions. Existing non-playing coaches and team responsibles were updated automatically.',
        ],
      },
    ],
  },
  {
    version: '1.32.0',
    date: '09.07.2026',
    sections: [
      {
        title: 'Volley referees admin page',
        items: [
          'Admins can now assign each volleyball referee to the team(s) they cover — or mark them “External” — from a new “Volley referees” page, with a coverage check that flags any team or referee still unassigned.',
        ],
      },
    ],
  },
  {
    version: '1.31.0',
    date: '09.07.2026',
    sections: [
      {
        title: 'Multi-day events: respond per day',
        items: [
          'Per-day events (like a training weekend) now let you answer each day separately, or use the quick Yes / No on the card to accept or decline every day at once. The “Per day” button opens a day-by-day view. Before, the card only offered a single Yes/No that didn’t belong to any day, so the per-day breakdown always showed nobody attending.',
          'Editing a per-day event now works: changing the event’s dates moves its days to match, and saving no longer fails.',
        ],
      },
      {
        title: 'Filter a roster by guests',
        items: [
          'The multi-team participation list can now be narrowed to just guest players, and each guest shows their level.',
        ],
      },
    ],
  },
  {
    version: '1.30.0',
    date: '09.07.2026',
    sections: [
      {
        title: 'Filter a multi-team event roster by team',
        items: [
          'When an event involves more than one team, the participation list now has a team filter. Pick one or more teams (or leave it on “All teams”) and the whole view narrows to just those teams — the Confirmed / Maybe / Declined / No response counts, the member list, the coaching staff and the CSV / PDF / image exports all update together. Games and trainings, which only ever involve one team, are unchanged.',
        ],
      },
    ],
  },
  {
    version: '1.29.0',
    date: '08.07.2026',
    sections: [
      {
        title: 'Issue a fine directly, branded confirmations',
        items: [
          'Coaches, team responsibles and admins can now issue a fine directly from the Fines page — pick a team and member, and the amount fills in from that team’s fine catalog. Previously a fine could only be started from the roster’s late-sign-in prompt.',
          'Confirmation pop-ups across Club finances (mark an expense paid/rejected, delete a ledger or team entry, cancel an invoice, switch dues emails to live) are now proper in-app dialogs — themed and dark-mode aware — instead of the plain browser pop-up.',
        ],
      },
    ],
  },
  {
    version: '1.28.0',
    date: '08.07.2026',
    sections: [
      {
        title: 'Shared internal note on expenses',
        items: [
          'Expense reimbursements now have a shared internal note that finance, the section TK and admins can all read and edit — a place to leave each other notes while a reimbursement is being processed. It is never shown to the member.',
        ],
      },
    ],
  },
  {
    version: '1.27.0',
    date: '07.07.2026',
    sections: [
      {
        title: 'Home “next 7 days” ticker + team birthdays',
        items: [
          'The home page now has a scrolling banner showing everything coming up in the next 7 days for your team(s) — games, trainings, events, hall closures and birthdays — all in one glance. Admins see it across every team.',
          'Team birthdays now appear in the calendar too, visible only to that team (never public). Toggle them under Filter → “Birthdays”. Only members whose birthday visibility is set to “full” are shown, so anyone who kept theirs private stays private.',
        ],
      },
    ],
  },
  {
    version: '1.26.0',
    date: '07.07.2026',
    sections: [
      {
        title: 'Standardized contact data + smarter signup form',
        items: [
          'Phone numbers, IBAN, AHV numbers and emails are now stored in one standard format everywhere (e.g. +41 79 123 45 67), and existing entries were cleaned up automatically. The ClubDesk sync repairs values in both directions.',
          'The signup form on kscw.ch now checks the AHV number (check digit), phone number and email before submitting, and offers an optional IBAN field — used only to pay money back to you (e.g. expense reimbursements), never to collect payments.',
          'Editing your profile validates the phone and AHV number the same way.',
        ],
      },
    ],
  },
  {
    version: '1.25.0',
    date: '07.07.2026',
    sections: [
      {
        title: 'Scorer duty: HU20 referee + simpler assignment',
        items: [
          'HU20 home games are now staffed with a scorer and a referee instead of a scoreboard operator. The referee is assigned to a team like the scorer, and any member of that team can take it — no licence needed.',
          'Scorer and scoreboard duties no longer require a licence either, so the auto-assignment can draw on any team. MiniVB and DU20 are no longer assigned scorer duties.',
        ],
      },
    ],
  },
  {
    version: '1.24.0',
    date: '07.07.2026',
    sections: [
      {
        title: 'Club stats: pick a season',
        items: [
          'Club statistics now has a season selector next to the sport toggle, defaulting to the current season. Schreiber coverage and win/loss results follow the selected season instead of mixing in last season\'s data; the rest of the page stays current.',
        ],
      },
    ],
  },
  {
    version: '1.23.0',
    date: '07.07.2026',
    sections: [
      {
        title: 'Scorer assignment tool for admins',
        items: [
          'Admins have a new "Scorer assignment" page in the Admin menu that automatically assigns scorer and scoreboard (Täfeler) duty teams to home games — for both volleyball and basketball.',
          'A per-team overview at the top shows how many duties each team received; every game can be reviewed and changed before saving, and a built-in rules panel explains how the algorithm decides.',
        ],
      },
    ],
  },
  {
    version: '1.22.0',
    date: '06.07.2026',
    sections: [
      {
        title: 'Expense reimbursements: status tracking',
        items: [
          'Uploaded expenses now appear under "My submissions" on the upload page with their status — pending, paid or rejected — including any note from finance, and you can re-open your receipt.',
          'You get a notification (in-app, email and push) the moment finance marks your expense as paid or rejected.',
          'Finance manages all submissions in a new Expenses tab in Club finances: change the status, leave a note for the member, correct details and open the receipt. Marking as paid also creates the linked payout with its QR-bill.',
        ],
      },
    ],
  },
  {
    version: '1.21.2',
    date: '06.07.2026',
    sections: [
      {
        title: 'Calendar: hall closures show every affected hall',
        items: [
          'A closure covering several halls showed only the first hall (e.g. "KWI A" when A, B and C were closed). The calendar now lists all affected halls in one entry — "KWI A, B, C".',
        ],
      },
    ],
  },
  {
    version: '1.21.1',
    date: '06.07.2026',
    sections: [
      {
        title: 'Dates follow your language',
        items: [
          'Weekday and month names (game details, calendar headers, scorer rows, event badges, date pickers) now render in your selected language — Italian, French and English users no longer see German day/month names. Numeric dates keep the Swiss dd.mm.yyyy format everywhere.',
        ],
      },
    ],
  },
  {
    version: '1.21.0',
    date: '04.07.2026',
    sections: [
      {
        title: 'Data health: ClubDesk drift detection',
        items: [
          'Members whose wiedisync contact data no longer matches ClubDesk now surface in Data health with the exact field differences — one click marks them for the next sync-up.',
          'Fields wiedisync has but ClubDesk lacks are grouped into one bulk row per field, so they can all be marked at once.',
        ],
      },
    ],
  },
  {
    version: '1.20.0',
    date: '04.07.2026',
    sections: [
      {
        title: 'Registration documents are now enforced',
        items: [
          'Basketball registrations can no longer be created without their required documents: the website form uploads each file the moment it is picked, and the registration is only submitted once everything required is in.',
          'Approval is blocked while required documents are missing, with a clear message on the Anmeldungen page.',
          'New "Dokumente nachreichen" page on the website: missing documents can be submitted later with the reference number and email from the confirmation.',
        ],
      },
    ],
  },
  {
    version: '1.19.0',
    date: '04.07.2026',
    sections: [
      {
        title: 'ClubDesk status on every approved registration',
        items: [
          'Each approved registration (Anmeldungen) now shows a ClubDesk sync zone: whether the person already exists in ClubDesk, is found there but not linked yet, or is missing entirely.',
          'One-click actions per person: link an existing ClubDesk contact, or push just this person to ClubDesk — no need to run a full sync for a single new member.',
        ],
      },
      {
        title: 'Polls: results visible to members',
        items: [
          'Polls have a new "results visible to everyone" option (on by default for new polls): members can see the vote counts after voting, not just managers. Who voted for what stays visible to managers only.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'The Data health page no longer fails to load when the "Missing sex" check runs.',
        ],
      },
    ],
  },
  {
    version: '1.18.0',
    date: '03.07.2026',
    sections: [
      {
        title: 'Account signup by personal invite',
        items: [
          'New WiediSync accounts are now created through a personal, single-use invite link — sent automatically when your club registration is approved, or by your coach, team responsible or the club board. This prevents duplicate member records.',
          'Existing members without an account can still activate it the usual way with their registered email address.',
          'Coaches and team responsibles can send an account invite to roster members who have no login yet — with a QR code to scan in person, plus the link by email. Every invite and approval email now includes a short step-by-step guide.',
        ],
      },
      {
        title: 'Game planning opens to coaches',
        items: [
          'Coaches and team responsibles can now open the game-planning calendar for their own team (view only) — see planned and confirmed match dates without asking the Spielplaner.',
        ],
      },
      {
        title: 'Fixes',
        items: [
          'Guest invite links (QR) from the team page work again.',
          'Fixed an issue where an account created via the claim flow ended up without permissions.',
        ],
      },
    ],
  },
  {
    version: '1.17.0',
    date: '29.06.2026',
    sections: [
      {
        title: 'Scheduling: lone Saturday games move to the small hall',
        items: [
          'A Saturday home game that is the only one at its time is now placed automatically in KWI C (the single hall) — freeing the double hall (KWI A+B) for basketball. Two games at the same time take KWI A+B, three fill A+B+C.',
          'This runs by itself whenever a game is booked, moved or cancelled, and VolleyManager is kept in sync. A new "Optimize now" button (Scheduling → Settings) applies it on demand.',
        ],
      },
    ],
  },
  {
    version: '1.16.0',
    date: '28.06.2026',
    sections: [
      {
        title: 'Polls: managers can see who voted',
        items: [
          'Team managers (coaches & team responsibles) now see per-member answers on a poll — who picked each option — beneath each result, not just the totals.',
          'This respects the poll\'s Anonymous setting (chosen when creating the poll): an anonymous poll stays totals-only, even for managers.',
        ],
      },
    ],
  },
  {
    version: '1.15.0',
    date: '28.06.2026',
    sections: [
      {
        title: 'Surveys are easier to find — and managers see live replies',
        items: [
          'Active surveys now appear on the home screen, right under the news — open polls for your teams show up there so you can vote without digging into a team page.',
          'Team managers (coaches & team responsibles) can now see a poll\'s replies live: the running tally is visible at any time, not only after the deadline. Everyone else still sees results once they\'ve voted or the deadline has passed.',
        ],
      },
    ],
  },
  {
    version: '1.14.0',
    date: '28.06.2026',
    sections: [
      {
        title: 'Scheduling: block dates from the settings',
        items: [
          'New "Blocked dates (whole club)" setting (Scheduling → Settings) — block days where no team plays home games (club holidays, tournaments, hall-wide events). Editable only by a superadmin; coaches\' own per-team blocks still apply on top.',
          'The closed dates (hall closures) — automatic ones from school holidays and the calendar sync, plus manual closures — are now managed right there in Settings too.',
        ],
      },
    ],
  },
  {
    version: '1.13.0',
    date: '28.06.2026',
    sections: [
      {
        title: 'Keep member data in sync with ClubDesk (admins)',
        items: [
          'A new "Sync down from ClubDesk" button (Registrations page) pulls the latest member data from ClubDesk on demand, instead of waiting for the weekly sync.',
          'A new "Sync up to ClubDesk" opens a review modal that previews exactly which members are new or changed, lets you choose which to push, then writes them into ClubDesk — updating existing contacts (matched by email) rather than creating duplicates — and shows the result.',
          'Both are admin-only, and the sync-up always shows a preview for you to confirm before anything is written to ClubDesk.',
        ],
      },
    ],
  },
  {
    version: '1.12.0',
    date: '26.06.2026',
    sections: [
      {
        title: 'Choose which emails you receive',
        items: [
          'Your profile has a new "Email notifications" section: switch off the alerts you don\'t want — new registrations, team join requests, form submissions, club news, and event invitations.',
          'Each toggle only appears if you can actually receive that alert (join-request alerts show for coaches and team responsibles, for example). Turning one off silences the email — or, for form submissions, the push notification — while the in-app bell still shows it.',
          'Everything stays on by default, so nothing changes until you opt out.',
        ],
      },
      {
        title: 'Finance: the Ledger shows your real books, and stays current',
        items: [
          'The Ledger\'s Journal and Trial balance now show your imported ClubDesk bookings (marked "ClubDesk"), so the book of record reflects your actual accounting — native entries you post in wiedisync layer on top.',
          'Finances now sync automatically from ClubDesk every night, and a "Sync now" button (Finance → Sync) refreshes them on demand.',
          'Export the income statement, balance sheet, budget and trial balance as a polished PDF, Excel workbook or PowerPoint deck — an "Export" button on each report.',
          'One fiscal-year selector for the whole Finance area, and changing the year (or any filter) no longer blanks and reloads the page.',
        ],
      },
    ],
  },
  {
    version: '1.11.0',
    date: '26.06.2026',
    sections: [
      {
        title: 'Club accounting, built in: your own double-entry ledger',
        items: [
          'Finance has a new "Ledger" tab — a full double-entry book of record inside wiedisync, so the club can keep its own accounts instead of relying on an external tool.',
          'It runs itself: once turned on, the ledger posts automatically from the club\'s activity — every invoice, payment, reminder fee, credit note, refund, write-off and per-team sponsoring becomes the right journal entry, with receivables kept in balance.',
          'Your existing ClubDesk chart of accounts is shared with the ledger — just map the bank, receivables and income accounts and switch auto-posting on.',
          'Dues income can be booked per membership category — map each category (Passivmitglieder, Aktivmitglieder, J+S …) to its own income account to mirror ClubDesk\'s breakdown.',
          'Everything a set of books needs: a journal you can post and reverse entries in, a trial balance, and a guided year-end close (Jahresabschluss) that moves the result into equity and carries balances into the next year. A "Reconcile now" button keeps the ledger in step with the rest of finance.',
          'Closed years are locked — entries can no longer be changed, only corrected with a reversal, the way proper accounting requires.',
        ],
      },
    ],
  },
  {
    version: '1.10.0',
    date: '25.06.2026',
    sections: [
      {
        title: 'Scheduling mailbox: its own tab, with a Volleyball/Basketball switch',
        items: [
          'The scheduling mailbox moved out of the dashboard into its own "Mailbox" tab, next to Dashboard and Settings.',
          'Switch between the Volleyball and Basketball mailboxes with a toggle at the top — each is its own account (spielplanung@volleyball.kscw.ch / spielplanung@basketball.kscw.ch). You only see the sports you have access to.',
          'A proper mail client: separate Inbox and Sent, plus reply, reply all, forward (keeps the original attachments) and new email.',
          'On the volleyball side, emails still group by opponent — the dashboard "N emails" button opens that opponent’s thread in the new tab.',
        ],
      },
    ],
  },
  {
    version: '1.9.1',
    date: '25.06.2026',
    sections: [
      {
        title: 'Game scheduling: hand schedules over to the Swiss Volley feed on a set date',
        items: [
          'Set a "Feed takeover date" per season in the scheduling settings. Until that date, the dates, times and venues you arranged in the tool are protected from the official Swiss Volley feed — which can still show a placeholder until your opponents enter your away games in Volleymanager.',
          'On and after that date, the official feed takes over date, time and venue automatically, since by then every opponent has had time to enter their away games. Scores and results always sync regardless.',
          'Leave the date empty to keep protecting scheduled games until they are played, as before.',
        ],
      },
    ],
  },
  {
    version: '1.9.0',
    date: '25.06.2026',
    sections: [
      {
        title: 'Finances: bill membership dues in one run',
        items: [
          'Set the membership fee per category (and per section) for a season, then bill every active member in those categories in one go — each gets a payable QR-bill in the app.',
          'Preview before you bill: see exactly who will be charged, how much, and who is missing a rate or already billed.',
          'Re-running is safe — members who already have a dues invoice for the season are skipped, so nobody is billed twice.',
          'Cancel a whole run to void its still-open invoices; paid ones are kept.',
          'Download all of a run\'s bills as one PDF — a Swiss QR-bill per member to print and post, or attach yourself.',
        ],
      },
    ],
  },
  {
    version: '1.8.0',
    date: '24.06.2026',
    sections: [
      {
        title: 'Finances: per-member explorer + a dedicated Finance role',
        items: [
          'New "Finance" role for the treasurer and finance team — the club-finance dashboard and the new per-member view, on top of normal member access, without full board permissions.',
          'A Members tab in Club finances: search any member to see their contact details, IBAN, membership category and full invoice history with payment status, all in one place.',
          'Record a separate billing contact per member — for a minor billed to a parent/guardian, or a company that pays — used when addressing invoices.',
          'Attach the invoice PDF to any invoice and open it later. Documents are private to finance and the board, and stay correctly linked to their ClubDesk invoice across nightly syncs.',
        ],
      },
    ],
  },
  {
    version: '1.7.0',
    date: '24.06.2026',
    sections: [
      {
        title: 'Finances',
        items: [
          'Invoices you pay through the app now reconcile automatically with club accounting — the payment carries the invoice number in the standard format, so no manual matching is needed.',
        ],
      },
    ],
  },
  {
    version: '1.6.1',
    date: '24.06.2026',
    sections: [
      {
        title: 'Game scheduling: accurate dashboard counters',
        items: [
          'The Spielplanung dashboard\'s home/away game counters now count every leg of a pairing, so junior teams that play an opponent two or three times are tallied correctly — no more "more games confirmed than the season has".',
        ],
      },
    ],
  },
  {
    version: '1.6.0',
    date: '23.06.2026',
    sections: [
      {
        title: 'Finances: invoices you can pay in the app',
        items: [
          'The Fines page now lives in one Finances menu, alongside My finances, Upload invoice and Club finances (for the board).',
          'The board can create an invoice for a member or a whole team — for example a Swiss Volley fine — right in Club finances.',
          'You pay invoices in the app: open one under My finances, scan the QR-bill with TWINT or your banking app, then tap "I\'ve paid". It shows as pending until the treasurer confirms the money arrived.',
          'Team invoices appear for the team\'s coach, captain and responsible.',
          'The board can link ClubDesk invoices that weren\'t matched to the right member (e.g. billed to a parent\'s email), and the link sticks across syncs.',
        ],
      },
    ],
  },
  {
    version: '1.5.0',
    date: '22.06.2026',
    sections: [
      {
        title: 'Smarter junior game slots',
        items: [
          'Junior (U-) teams can now choose Friday-evening slots as their 1st and 2nd home-game options once Saturdays and the Tuesday Döltschi slots are used up — previously Fridays were only ever a 3rd choice.',
          'Sundays now work the same way, and the U-teams are steered to play together: once one U-team takes a Sunday, that Sunday becomes a strong option for the others.',
          'New "Show cross-team conflicts" toggle on the planning calendar — pick a team and the calendar marks the days another team that shares its players already plays, i.e. the days that block a home game.',
        ],
      },
    ],
  },
  {
    version: '1.4.0',
    date: '22.06.2026',
    sections: [
      {
        title: 'Smoother game planning',
        items: [
          'Adding a manual game now picks up the calendar filters you already set — the sport, team and home/away carry straight into the dialog.',
          'A new sport picker in the dialog narrows the team list to volleyball or basketball.',
          'The "KWI A + B" double-hall booking is now available for every team, not just basketball — and it warns you if either half is already taken.',
          'The "Show absences" toggle works again: calendar days show a badge with how many players are unavailable for games that day. Hover or tap it to see who.',
        ],
      },
    ],
  },
  {
    version: '1.3.0',
    date: '22.06.2026',
    sections: [
      {
        title: 'Game planning, one tap away',
        items: [
          'The game-planning tools are now a single "Planning" entry in the menu — the separate "Manual game calendar" and "Match scheduling" tabs are gone.',
          'Installed Wiedisync to your home screen? Opening Planning now launches it in your browser instead of getting stuck inside the app window.',
        ],
      },
    ],
  },
  {
    version: '1.2.0',
    date: '20.06.2026',
    sections: [
      {
        title: 'League standings by season',
        items: [
          'Rankings now have a season picker — see the current tables, look back at last season\'s final standings, and browse the archive.',
          'Earlier seasons are kept instead of being overwritten when a new season starts, so the history stays put. Last season (2024/25) has been added back in.',
          'For a season Swiss Volley hasn\'t published yet, the rankings show a short "Data to be shared later by Swiss Volley" note instead of an empty table.',
        ],
      },
    ],
  },
  {
    version: '1.1.0',
    date: '19.06.2026',
    sections: [
      {
        title: 'Loading & polish',
        items: [
          'Pages now wait for all their data before showing — no more tables and cards popping in a moment after the screen appears.',
          'A refreshed loading screen with the spinning club logo, a gold progress bar with a percentage, and a few playful messages while you wait.',
        ],
      },
    ],
  },
  {
    version: '1.0.0',
    date: '19.06.2026',
    sections: [
      {
        title: 'Teams & rosters',
        items: [
          'Team cards with photos, club colours and per-team guest levels; manage positions, captain, coaches and team responsibles.',
          'Coaches have their own section on the team page, separate from the players.',
          'Export a roster as CSV, PNG or PDF with an activity header and a position summary.',
          'Join or leave a team straight from the Teams page, and invite external players with a QR code.',
        ],
      },
      {
        title: 'Trainings, games & RSVP',
        items: [
          'RSVP Yes / Maybe / No in real time, add a note, count guests and pick recurring trainings.',
          'Auto sign-in (opt-out attendance): you\'re confirmed automatically for new trainings, games or events — you only act when you can\'t make it, and absences always win. Set it per team, override it per activity, or switch it on for yourself.',
          'Coaches can edit participation inline and log an absence on a player\'s behalf, always shown with who changed it and when.',
          'Cancel a training, event or game from the calendar — the team is notified, RSVPs freeze and a cancelled training frees its hall slot.',
        ],
      },
      {
        title: 'Calendar & Hallenplan',
        items: [
          'Monthly calendar with home / away colours, clickable absence bars, game-Saturdays in gold and hall closures highlighted.',
          'Hall slots that coaches can claim; editing a slot cascades to every future session while keeping RSVPs and notes, and open-ended slots keep a rolling calendar.',
        ],
      },
      {
        title: 'Absences & availability',
        items: [
          'Track absences and weekly unavailabilities; a weekly unavailability overrides an existing "confirmed".',
          'Mark an absence non-blocking so the player shows as away for their own games, but the date stays open for scheduling the rest of the team.',
          'A team absence calendar with multi-team select.',
        ],
      },
      {
        title: 'Games & scoreboard',
        items: [
          'Upcoming games and results with set scores, total or per-game standings, and an embeddable scoreboard.',
          'Daily automatic sync with Swiss Volley and Basketplan keeps scores and standings fresh.',
        ],
      },
      {
        title: 'Game scheduling (Spielplanung)',
        items: [
          'Plan a whole season against opponents: send a club a tokenized invite, they propose home and away slots, and you confirm — with the tool enforcing availability, absences, hall closures, game spacing and intra-club derby rules automatically.',
          'Confirmed home games push straight into VolleyManager, and confirmed games appear on the app calendars right away.',
          'An in-app mailbox brings opponent email replies into the dashboard; leave remarks both ways, see per-team availability, export to Excel / PDF and search across all teams.',
          'Scheduling lives on its own address (spielplanung.wiedisync.kscw.ch) with single sign-on.',
        ],
      },
      {
        title: 'Scorer duty',
        items: [
          'Sign up for scorer duty with delegation, and an auto-assignment planner that builds a fair duty plan for both volleyball and basketball home games.',
        ],
      },
      {
        title: 'Messaging',
        items: [
          'Team conversations, direct messages, polls, reactions and reports, with a personal inbox for your message notifications.',
        ],
      },
      {
        title: 'Forms',
        items: [
          'Build custom forms (short / long text, single or multiple choice, number, date, yes/no, file upload) for the whole club or specific teams.',
          'See responses in a table and export to Excel, CSV, JSON or PDF; remind non-responders; let members edit their answer; or make a form public with its own shareable link.',
        ],
      },
      {
        title: 'Fines',
        items: [
          'Issue fines with per-team escalation tiers (late sign-in, no-show, late payment or custom), see your outstanding fines on your profile, and waive one with a reason.',
        ],
      },
      {
        title: 'Finance',
        items: [
          'Board finance dashboard with income statement, balance sheet and an accounts drill-down, mirrored from ClubDesk.',
          'Pay your dues from the app by scanning a per-invoice Swiss QR code with TWINT or any banking app.',
          'Submit an expense for reimbursement: upload the receipt, let it read the amount, date and vendor automatically, and confirm your IBAN.',
        ],
      },
      {
        title: 'News, broadcasts & notifications',
        items: [
          'Club-wide announcements on the home news card, and targeted broadcasts by email and push with spam protection.',
          'In-app and web-push notifications for new activities, RSVP changes and broadcasts.',
        ],
      },
      {
        title: 'Admin & data tools',
        items: [
          'A Data Explorer to browse teams, members, events and games with instant fuzzy search and member filters.',
          'A superuser SQL workspace, a public status page with live sync heartbeats, and an audit log of who did what.',
        ],
      },
      {
        title: 'Accounts, languages & platform',
        items: [
          'Log in with email and password; seven clear roles, each with their own view; privacy settings and GDPR account deletion.',
          'Five languages (German, English, French, Italian, Swiss German), dark mode, Swiss dd.mm.yyyy dates throughout, install-to-home-screen (PWA) and step-by-step guided tours.',
          'Your Swiss Volley licence card on your profile, kept live from Volleymanager.',
        ],
      },
    ],
  },
]

export { APP_VERSION }

export default function ChangelogPage() {
  const { t } = useTranslation('nav')
  const { t: tSupport } = useTranslation('support')
  const donateVisible = useDonateVisible()

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <ScrollText className="h-6 w-6 text-brand-600 dark:text-gold-400" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('changelog')}</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Wiedisync v{APP_VERSION}</p>
      </div>

      <div className="space-y-8">
        {CHANGELOG.map((entry) => (
          <div key={entry.version}>
            <div className="mb-4 flex items-center gap-3">
              <Badge variant="default" className="font-mono">v{entry.version}</Badge>
              <span className="text-sm text-gray-500 dark:text-gray-400">{entry.date}</span>
            </div>

            <div className="space-y-4">
              {entry.sections.map((section) => (
                <div key={section.title}>
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    {section.title}
                  </h3>
                  <ul className="space-y-1">
                    {section.items.map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500 dark:bg-gold-400" />
                        <span className="text-justify hyphens-auto">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Someone who just read what shipped is the warmest moment to ask —
          and the only other place this is offered is the options menu. */}
      {donateVisible && (
        <Link
          to="/support"
          className="mt-8 flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <Coffee className="h-4 w-4" />
          {tSupport('menuLabel')}
        </Link>
      )}
    </div>
  )
}
