---
title: "Mark Lutz / Eric Pearson — Onboarding & Project Sync"
type: meeting_transcript
source_file: MarkEric.txt
date: unknown (recorded 13:31–14:11)
duration_min: 40
participants:
  - name: Mark Lutz
    role: Marine Layer Advisors (tech/ops lead; Eric's manager)
  - name: Eric Pearson
    role: Marine Layer Advisors (developer, recently joined)
tags: [hubspot, crm, meeting-recorder, ai-summaries, justcall, mcp, claude-partners, railway, heroku, supabase, luma, dashboards]
---

# Mark Lutz / Eric Pearson — Onboarding & Project Sync

> **Note for agents:** Sections 1–4 are a structured digest of the call. Section 5 is the full transcript. Consecutive lines from the same speaker are merged and pure filler lines ("Um…", "Uh…") removed; wording is otherwise verbatim and may contain speech-to-text errors (e.g., "Nest Next" = Next.js, "plot" = Claude, "Mtp" = MCP, "IIS summary" = AI summary). The recording ends mid-sentence during the Luma walkthrough.

## 1. Summary

Mark walked Eric through the internal meeting-recorder pipeline (Recall bot → transcripts → AI summaries → email recap) and assigned the first project: push per-contact AI meeting summaries into HubSpot. Longer term, they want a two-way HubSpot bridge (including ingesting JustCall phone recordings) as groundwork for replacing HubSpot with an in-house CRM. They also covered repo layout and infrastructure, a Claude partner-program research task, Eric's status updates (Supabase prod password-reset bug, pagination fix PR), a discussion of "push not pull" adaptive AI UIs, and began a walkthrough of Luma.

## 2. Key Context

### Meeting recorder / AI summary pipeline
- Recall bot follows calendars and joins meetings; default skips internal-only (same-domain) meetings. Settings sometimes reset.
- Fallback: Slack command `record <meeting link>` makes the bot join.
- Transcripts land in a "meeting transcripts" table (~1,000 rows).
- Each meeting is classified as **client**, **internal**, **service** (vendor/provider) or **interview**, then AI-summarized into per-category tables (client interactions, service interactions, interview interactions, plus a separate internal table).
- Client summaries have structured fields: pain points, objections, desired outcome, capabilities discussed, action items, touchpoint, personal details.
- Client summaries are **per contact** (6 advisors on one call → 6 summaries). Keys include contact ID and salesperson ID.
- Internal attendees get an auto-emailed "summary of the summary"; internal meetings get per-person follow-ups.
- A legacy push-to-Pipedrive function exists and is the model for the HubSpot push.

### HubSpot
- Replaced Pipedrive. Mark dislikes it; head of sales **Drew Kane** designed the setup.
- Currently **pushed** to HubSpot: structured note data and production records (trade revenue, commissions, re-offer after ISC's 10 bp broker-dealer fee, per-salesperson payout by schedule, e.g. senior external 20%, senior internal 5%, trader 1%). Revenue is provisional until the broker-dealer pays, then finalized for payouts.
- **Nothing is pulled** from HubSpot yet.
- **JustCall** (HubSpot app) records voice-only phone calls; these aren't in the backend yet.
- Core CRM needs: drip prospecting campaigns (emails 1–4), lifecycle promotion (cold prospect → warm lead → client), call/email logging, revenue.

### Repos & infrastructure
- **MLA Notes Sync**: main backend repo (data flows, DB transformations, misc processes). Root has a **RepoMap** document with a section per workflow; start there.
- **Portfolio Harmony Tool**, **MLA Client Portal**: front-end repos.
- Former dev **Roshan** made separate repos for **GBrain** and the AI agent **Milton**; these can stay separate or be consolidated into MLA Notes Sync (consolidation preferred).
- **Railway**: backend services/APIs (services have auto-generated names that need renaming; one hosts the **MLA MCP server**). Now behind 2FA.
- **Heroku**: most front ends (e.g., Navigator).
- **Supabase**: database; has default row limits, so missing pagination is a recurring bug.

## 3. Decisions & Agreements
- First priority: AI summaries → HubSpot, before building a custom CRM.
- The FUL ingester Eric started is **backend-only, no UI** (for now).
- Eric may fix small issues he finds on his own (branch → fix → PR → merge). Mark endorsed this.

## 4. Action Items

| Owner | Task |
|---|---|
| Eric | Build **push-to-HubSpot** for AI meeting summaries: attach to existing HubSpot meeting on the contact, or create one if none exists. Map backend summary fields to HubSpot meeting fields via the API. Base it on the Pipedrive push script (find via RepoMap in MLA Notes Sync). |
| Mark | Send Eric the HubSpot API key(s). |
| Mark | Ask Drew Kane to identify the important HubSpot objects for Eric. |
| Eric | Explore HubSpot data/objects; propose internal schemas mirroring Drew's design and a plan to ingest/sync (step toward an in-house CRM). |
| Eric | Plan ingestion of JustCall phone recordings into the backend and run the AI summarization on them. |
| Eric | (Free time) Research the Claude partner program / Claude for Financial Services partners and how MLA could become the structured-notes partner ("new-world SEO"). Requested by Vinay. |
| Eric | Follow up with Zarco Monday on the prod Supabase password-reset failure (likely tied to a Gmail integration on Mark's account); escalate to Mark if stuck. Not blocking. |
| Mark (optional) | Rename Railway services to meaningful names. |

### Status updates from Eric
- Prod Navigator (Heroku) password reset fails (works on dev); Eric can't log into prod front end but runs locally fine.
- Restored the nightly prod snapshot into dev; dev is current except for today's data.
- Merged a PR adding pagination to bulk pricing "show all" (it was timing out); reviewed with Kate.

### Product vision discussed
- Mark: AI interaction today is mostly **pull** (user prompts); the opportunity is **push** (proactive nudges like "meeting in 20 min, want help prepping?" with yes/no or free-text replies), especially for less AI-savvy advisors.
- Static UI still matters for alerts, statuses and reminders. The target is an adaptive, personalized portal that surfaces what the user cares about, learns from feedback, and can be reshaped through chat.
- Eric: urgent data up front / KPI bar of emergent action items; an "80/20" default view with customization options.
- Vinay is especially interested in this direction.

### Luma (walkthrough in progress at end of recording)
- Eric has a working Luma login.
- Two primary tabs are used; the **Lifecycle** tab shows structured notes across the MLA book and each advisor's book, focused on **events**: coupons (cash payments), and redemptions (called or maturing).

## 5. Full Transcript

**[13:31:44] Mark Lutz:** So, um… I need to change my recall setting, but um… Generally speaking, uh, recall the meeting, um, uh, recorder. joins every meeting and, like, just follows everyone's calendars and joins every meeting that someone puts on their calendar, but I think, like, the settings sometimes get reset, um, and uh… the default setting is that it doesn't join internal meetings, so if everyone has the same domain.

**[13:32:15] Eric Pearson:** Oh, okay.

**[13:32:15] Mark Lutz:** Then join. But. we can… screen. In, oh, sorry, wrong.

**[13:32:36] Eric Pearson:** Good.

**[13:32:37] Mark Lutz:** Alright. It's over here. So in, Slack, we can. Uh, we have some commands in Slack. Which, like, I love slack commands, they're just so easy. It's set up, but we could just put in, um, record, and then the meeting link, and then. It just joined. So…

**[13:33:00] Eric Pearson:** Oh, nice. Okay.

**[13:33:03] Mark Lutz:** So, if it doesn't, you know, if for whatever reason it doesn't join, um, then people can do that. Not that anyone uses it, but, you know, it is there. Um, so now this will, um… This will record. This will record the meeting, um… It will then go into meeting transcripts. Um, which will probably take a year to load, because it has a thousand transcripts in it. Um, and then from there, after every meeting.

**[13:33:36] Eric Pearson:** Thank you.

**[13:33:41] Mark Lutz:** we basically split it into 3 different designations. One is client meeting, one is, um, uh, internal meeting. Uh, actually, 4 designations. Client meeting, internal meeting, um, service meeting, which would be, like, uh, with a vendor. or like a service provider of some sort, and then an interview. And then AI will. We'll like summarize each of each of those, and then we have 4 tables that for for each one of those different categories. So. service interactions, um… Basically everything that has interactions in it. So, service interactions, interview interactions, client interactions, uh, and then I think the internal meeting one is a different one. And then this will have, um… Structured fields, um, that have, like. Um, pieces of summary. So, for client meetings, especially, which are definitely the most important thing, um… we have, like, uh, you know, pain points, objections, desired outcome, like… Uh, our capabilities talked about, action items, that touch point, like, um, personal details about the client, um, just all this good stuff that will be helpful for, um, a salesperson, um, for future meetings, and then we send out. Um, we auto-email everyone internally on the call with, like, a summary of the summary. Um… And then, uh… And so so everyone would then have that like the email summary is basically what everyone utilizes for like client meetings and stuff. Internal meetings. It'll you know the the email summary would have just like follow up items per person. Uh, and then the kind of next step that we want to do here is we want to push this to HubSpot. And in HubSpot, we have… I don't know if you've ever used HubSpot or, like, CRMs, um…

**[13:36:02] Eric Pearson:** I view CRMs in various capacities, but not HubSpot per se.

**[13:36:07] Mark Lutz:** Got it. I hate every single one of them. With a burning passion.

**[13:36:11] Eric Pearson:** Tell me what you really think.

**[13:36:13] Mark Lutz:** So just like. They're just always, like, there's always way too much, like, way more than anyone ever needs, and it's just, like, this is organized just so poorly, like… All this stuff, like, these categories make no sense. Like, I don't know what the difference is between, like, marketing and CRM and sales, like…

**[13:36:34] Eric Pearson:** Let me guess, you were not involved in the decision-making process on this.

**[13:36:38] Mark Lutz:** Well, we had a different… we had, um… Pipe Drive, I think, before. Um… And we, uh, wanted to move to something better. And so, like, HubSpot, like, they're just all so expensive. Um…

**[13:36:55] Eric Pearson:** I just rolled my own, honestly, and I did that after, like, I used SweetCRM for a bit, and then I just said. I basically kind of ported SweetCRM using, um, Hermes. I just said, hey, make a Nest Next, you know, JS version of this. And I said, but strip these pieces out. And it did.

**[13:37:13] Mark Lutz:** So, I definitely want to do that. Um, you will… I mean, you're probably already learning that there are a lot of things that I would love to do, but, like, I do not… I have not had time to do it, um, so…

**[13:37:16] Eric Pearson:** Yep. Yeah, again, your bandwidth seems to be kind of the sticking point.

**[13:37:27] Mark Lutz:** Yes. So thank you for being here. So I would love to create our own CRM.

**[13:37:31] Eric Pearson:** Uh-huh.

**[13:37:37] Mark Lutz:** I think we already have some of the pieces. I think it would be very… pretty simplistic, because, like. You know, we have… 8 things that we need, you know, as opposed to the 400 things in here. Um… And, and it's basically, like, sending out, like, prospecting campaigns where we, you know, have a drip campaign. We send out email 1, 2, 3, 4. We promote people from, like, a cold prospect to a warm lead to a client, blah blah blah. and we record phone calls and like emails. And like, that's kind of it. So. And I guess we do revenue stuff in here, too, which we already do in our backend, because we push all the revenue data to here. But anyways, um… Uh, what, like, we want to do, like, we, so we could definitely talk about, like, creating our own CRM and the needs of it. Um, but in the meantime, I think, like, we want to get the AI summaries into here, which, like, should be very simple. Um, so I think it's probably worthwhile to do this first. Um…

**[13:38:44] Eric Pearson:** I say IIS summary into HubSpot.

**[13:38:47] Mark Lutz:** And where? It is. All right, maybe et cetera, just contact.

**[13:38:57] Eric Pearson:** One second. Okay, so AI summaries into HubSpot. Okay.

**[13:39:07] Mark Lutz:** Yeah, so, um…

**[13:39:07] Eric Pearson:** I… Sure.

**[13:39:09] Mark Lutz:** Oh, go ahead if you had a question.

**[13:39:10] Eric Pearson:** No, no, no, go for it.

**[13:39:14] Mark Lutz:** Under a contact in HubSpot, we have meetings, and when there is a meeting recorded, which… find someone in… Yeah, of course.

**[13:39:31] Eric Pearson:** Not exactly, uh… user flow… A bowl, is it? It seems like… That was a kind of a missed thing here.

**[13:39:41] Mark Lutz:** Yeah, and, like, the thing that really frustrates me is, like, clearly, like, someone is filtering for, like. people in SoCal that are within 40 miles for, like, Vinay and Sanjay to go meet, or something. But it's like, why is this filtering for every single user, and not just the person who created it? Like, that is… and, like, now I'm like, if I, like, change this, is this gonna, like, fuck up someone else's, like, workflow?

**[13:40:04] Eric Pearson:** Yeah, yeah, no, I totally get it.

**[13:40:06] Mark Lutz:** Uh, so…

**[13:40:08] Eric Pearson:** Are you on, like, a global account versus just, like, a user account? I don't know how it's set up, but… nope, looks like it's just you, okay.

**[13:40:14] Mark Lutz:** I know I'm on. Yeah. But.

**[13:40:16] Eric Pearson:** All right. Yeah, I don't know.

**[13:40:19] Mark Lutz:** Anyways, there would normally… there would be meetings in here, and, um, uh, just using, like, whenever the AI summary gets finished, we actually are, um, previously had a, like, push-to-pipe drive, um, function.

**[13:40:20] Eric Pearson:** Yeah, thank you.

**[13:40:35] Mark Lutz:** And, uh, we just wanna add, like. a push-to HubSpot function that would either attach it to the meeting if it already exists, or create a new meeting if it does not exist. Um, on the contact. And our, um…

**[13:40:50] Eric Pearson:** Like so. Are our meeting identifiers like Zoom, the Zoom meeting IDs, our meeting identifiers? Add to existing. If it exists. If, um… Add a unit.

**[13:41:07] Mark Lutz:** I'm not sure, like, in terms of our meeting identifiers, we have, um… Yeah. We have we have, like, an ID. Let's see what the. I'm very sorry. Yeah, so it's like, it's the, um, the contact ID, the salesperson ID, uh, because we do it based, um, we do, uh, client meetings per person, so, like, the AI summary, rather, is per person, so if there are six. Um, uh, advisors on a single call from one firm will have 6. AI summaries in there, and it could be very overlapping, but, like, you know, if one of the person… one of the advisors has 3 kids and talks about having 3 kids and going on a trip, then that one AI summary will get that information. Otherwise, it'll all just be, like, firm information, if they're all similar.

**[13:41:45] Eric Pearson:** Summaries.

**[13:42:04] Mark Lutz:** So, um, so that should map pretty nicely to HubSpot, because HubSpot meetings are seemingly per person. Uh, but we have an API… um, into HubSpot, um, that I could give you the, um, the key for, and then you can just have AI figure out, kind of, what the… what the meeting, um. um, fields are, and then what fields we have, and um, and then just figure out how to link the two, I think is, like, the pretty simplistic approach, and then, um, I'll tell you where the script is, um. But it should be in… in the MLA and, uh, I guess let me just back up a second and say the MLA Notes Sync repo is, like, kind of our main repo for, like, backend work. Um, it's where I have put everything that I have built into. We have… and I would say the other repos are kind of more dedicated repos. Portfolio Harmony Tool, obviously, front-end for that. MLA Client Portal, front-end for that. MLA Notes Sync does a lot of the, like, back-end, kind of, data flow and transformations for our database, and then any other processes that we have, kind of, away from these more, like, productized. Things. And, um… uh, like, I know, like, Roshan, our old dev, created, like, a repo for GBrain, um, and I think he created another repo for, like, um, for our AI agent, which we call Milton, um… And which is a joke on someone that we all used to work with.

**[13:43:53] Eric Pearson:** Oh, was it like, I'm going to burn this place down because you took my red stapler, that one?

**[13:43:59] Mark Lutz:** Uh, yeah, basically. Um, yeah, just someone that we work with that we all find to be a very special person. Um…

**[13:44:00] Eric Pearson:** Yeah. Yeah, yeah.

**[13:44:08] Mark Lutz:** And so, um… uh… so I think he created separate repos for that. If we want to keep those as separate repos, totally fine. If we want to just put everything in the MLA notes thing, we could also do that, but, like… generally speaking, we have tried to keep things mostly organized and into a singular repo, and then, um, in… in MLA NoteSync, we have, um… I've created… I've tried to create a lot of documentation around, like, where things are. Um, it's not perfect. It's always just difficult with. quick moving stuff to keep documentation up to date. But there is… there's, like, at the root level, there's stuff like RepoMap, which should have, like, um, sections for every single workflow. Um, I am telling you this because, like, if you just, like, have AI go search around in there, that document should be a pretty quick, like, um… uh, um, you know, um, yes, map, yes, thank you, that's the word I was looking for, um, uh, in terms of where things are, and it'll have things like the meeting, like, AI summary, or 15 other names for, kind of, like, our meeting recorder, this is where all the scripts live, this is what it does, blah blah blah blah.

**[13:45:03] Eric Pearson:** map for it. Yep.

**[13:45:20] Mark Lutz:** Um, so, um, you should be able to find it pretty quickly. If not, let me know, and I can point you to the stuff, but… Um, that is, uh… One thing, um… I'll get you. Yeah, I'll give you the Api keys.

**[13:45:39] Eric Pearson:** Um, so just really quick, the FUL ingester that I, like, started working on yesterday, are we… is that strictly gonna just be an ingesting worker, or are we gonna need a UI to integrate that to Navigator or something in the front? Eventually.

**[13:45:55] Mark Lutz:** That will just be backend, no UI.

**[13:45:59] Eric Pearson:** That's what I was assuming, but I just wanted to make sure. Um, I usually build my stuff front-end agnostic anyway, so whatever wants to consume it can, so…

**[13:46:07] Mark Lutz:** Hold on. Cool. Yeah, I… yeah, at least, for now I don't see any reason why why we'll need an Ap. Ap. While why we would need a ui. But I. You know I reserve the right to change my mind.

**[13:46:29] Eric Pearson:** No! Oh, yeah. Oh, and recalcitrance. We need to like, come on now.

**[13:46:38] Mark Lutz:** Uh, how was the call with Kate, by the way?

**[13:46:41] Eric Pearson:** Good. Some good points. I did find out that like the function for me to reset my user on Supabase was broken on prod and it looks like it's because. There's some kind of, uh, Gmail integration piece that fell over, perhaps, um, where… how it sends… basically, it's when I click reset password, you know, and… or it sends the… the message out. Works fine on dev. In… in the prod one, it's like, I click it, it errors out, and then…

**[13:47:14] Mark Lutz:** Inshallah.

**[13:47:15] Eric Pearson:** Puts an item in the auth log. I… I think it's linked to your Gmail, I want to say, is what I thought I saw in there. So, I… I did reach out to Zarco, Zarco responded, so I can… I can… I mean, it's not urgent. So, um, I'm more than happy to let him, and then if he's unable, then, you know, I'll… what I'll do is I'll probably, like, I'll follow up with him Monday morning, and then just, you know, because I generally do, like, my little ticklers and just, hey. what's what's satisfying, you know? And if if it seems like either we're not getting anywhere or whatever, I'll I'll reach out to you and just say, hey. This is this is what I'm seeing. Can you help me? 'cause like it's got your account. But, um, like I say, right now it's, it's, this is not, it's not blocking me and it's not definitely, it's the only thing it's blocking me from seeing is like if I log into the Heroku, uh, deploy of the. Uh, Navigator, I can't get in right now. Um… I still have access, though, like, on the back end, so, like, literally, I've got, um, my… I pulled down the latest copy of the code, and then I'm running locally, and it's working fine, so… and then I made a snapshot of…

**[13:48:26] Mark Lutz:** Yep.

**[13:48:43] Eric Pearson:** I took the nightly snapshot that happens early in the wee hours from prod and put it into dev, so dev is up to date with the exception of the daily stuff today.

**[13:48:56] Mark Lutz:** Okay, perfect. Great. Thank you.

**[13:48:58] Eric Pearson:** Uh-huh. So I have been productive and it did get me a PR. It was kind of funny because like I hit a part on one of the pricing, I think it was the bulk pricing and like, of course, it didn't have the daily because there wasn't any pricing today yet. But, like, when you clicked all, it would sit there and time out. And so me and Claude looked into it, and it was just because the results weren't being paginated coming back. So I was like, okay. And it's like, pagination seems this seems like maybe somebody just hasn't hit this, or they don't click all usually, and they just stay on the default. So, I talked through the change with Kate. Kate was like, oh, yeah, that's fine. And then, so, I did the PR and merged it, so…

**[13:49:39] Mark Lutz:** Yeah, I've found… I think… I think it's Supabase, specifically. that, like, limits. It has row limits, automatically. And so the pagination is, like, has been an issue across so many things, that I have just constantly had to fix. So thank you. That's yeah.

**[13:50:01] Eric Pearson:** Of course.

**[13:50:02] Mark Lutz:** Yeah, annoying thing. But.

**[13:50:03] Eric Pearson:** I typically will do things like that, just so that you're aware, kind of like how I work, but, like, if it's something that I see as, like, I'm not that dev that's gonna, like, I'll ignore it, or, like, set it aside, I'll be like, this seems like it could be an issue, not just. scope to me, so, like, I'll… You know, kind of really quick, if it's a quick hit, I'll just like quickly, okay. Create a branch, make the change, do the PR, and then move on, you know.

**[13:50:31] Mark Lutz:** Um, perfect, because that, that is, that is definitely what I, what I want, um, is we, we certainly have a lot of things that are probably not working perfectly, um, as we've just built so much stuff, so, uh, yes, see anything, feel free to. do anything necessary.

**[13:50:47] Eric Pearson:** Cool. It's kind of like, yeah, my little snitchy, you know, see something, say something kind of thing, you know?

**[13:50:52] Mark Lutz:** Yeah, exactly. It's funny. Alright, so, um, so yeah, the meeting summaries, uh, in HubSpot, um… and then, uh, along with HubSpot, um, we have, uh, we are currently pushing some information into HubSpot, um. So we push… structure, note data. And then we also push. It's called production levels, but, um, or production records, but essentially it's, like, the, um… The revenue… And the commissions that we get from each trade. And then once we get revenue for a trade, every salesperson is on a schedule. Um, and then they get, um, you know, they get paid based on their schedule, where, like, you know, it's a senior external gets 20% of the revenue, a senior internal gets 5%, a trader gets. 1%, whatever, whatever, whatever. Um, and we have all sorts of random stipulations, because nothing can be simple. But we put in here, like, okay, like, what is the re-offer? Um, this final re-offer is, like, after, you know, I mentioned, um, the broker-dealer who's ISC takes a 10 basis point fee, so it's like, okay, what's the final re-offer that we get after the 10 basis point fee? And then. Um, based on this person being an internal, um, you know, they get, uh, $61.40, um. And so we'll do that for every, you know, every trade. Uh, that we make. And this…

**[13:52:41] Eric Pearson:** So this is basically the who gets what on the deal. Gotcha. Okay.

**[13:52:44] Mark Lutz:** Yes. Um, and then we communicate, essentially, um… When, uh, payments could go out to people, um, which is basically when we get paid, so we kind of have, like, uh… Um, a, uh… Um, like, a non-finalized version, um, of our revenues, and then once we get paid by the broker… by our broker-dealer, um, who gets paid by the banks, then we can be like, okay, now this is, like, finalized, and now we can actually pay out the salespeople. So we do that as well. I think we're just hiding. I think this hides some of the fields, maybe. So I like never come into Hubspot because I do not like it. So so I just usually have AI tell me what things look like.

**[13:53:38] Eric Pearson:** Gotcha.

**[13:53:38] Mark Lutz:** But. But anyway, so. All I'm saying is that we are currently sending some stuff to Hubspot, but we do not currently pull anything from Hubspot, and we want to kind of increase the the 2 way bridge between. Uh, our backend and HubSpot. Um… This, I also think, would be good, kind of, like… um, foundational work for creation of our own CRM is, okay, well, first, let's build kind of the schemas, um, that, um, based on kind of how Drew Kane, who's our head of sales. has designed HubSpot, um, and kind of built it the way that he wants, so that we could kind of replicate it, start pulling the data in, and start syncing with it, and then maybe, you know, we can start after we kind of replace the architecture, or, um, replicate the architecture. Then maybe we could start replicating some of the functionality, and then we could sever. Um, but that's kind of, like, what I think would be next steps is getting some of the stuff, especially stuff that we don't currently have. Um, like, um, I mentioned call recordings. Uh, in HubSpot, we use an app called JustCall. Um, and it records all of the phone calls. So, like, we have our own thing for video calls, but for phone calls, um, we use JustCall, and it records all the phone calls. And, uh, we're not getting that.

**[13:55:05] Eric Pearson:** And that's just voice only, right?

**[13:55:08] Mark Lutz:** Correct. And so we are not bringing that back into our back end. We'd like to bring that back into our back end again. Do the AI summarization. And so we could start expanding kind of the. Uh, the intelligence that we have on each of the customers. So that would be another kind of a piece that we'd like to build out with Hubspot. So, um… So yeah, I, yeah, so like we had this Paul's thing. Okay, so yeah, I haven't looked at any of this. But anyways, I'll give you the Api keys so that then you would be allowed to then just mess around and see all the data in here. And then maybe I'll have Drew Kane. um… give you some of the, uh, like, important, uh, objects. I think, like, essentially they call a table an object, um, so I'll have him give you some of the important objects, and then we could talk about… you could take a look, and then we could talk about how to, you know. Replicate or build the schemas internally, and how to start ingesting this data.

**[13:56:24] Eric Pearson:** Score. I love it.

**[13:56:27] Mark Lutz:** Alright, so that's kind of HubSpot stuff. Um, the other thing I had for you is, um… and then I kind of just want to go through some, like, more general workflow stuff. But someone mentioned to Vinay and Sanjay that they are, like, a Claude-approved vendor. Um, and Vinay sent me this. partners thing for Claude, and he was like, can we do this? Uh, and I was like, I don't know, and I had not looked into it. Um, but something that, uh, I would, uh, ask you in your free time to take a look at, um. And see kind of what this means and what we can do to kind of be more like, you know, AI approved and like partnered with AI and be like AI, you know, where we could get more kind of like FaceTime through AI. stuff, uh, especially, like, you know, Claude just released, like, um, you know, Claude for advisors, or Claude for finance, or some… something like that. Um…

**[13:57:21] Eric Pearson:** Yep.

**[13:57:30] Mark Lutz:** and they have a lot of partners, and they already have a structured note partner, and of course, we saw that and we're like, well, what the heck? Like, why aren't we a partner for structured notes? Um…

**[13:57:41] Eric Pearson:** I hope they know who we are.

**[13:57:42] Mark Lutz:** Yeah, exactly, like, we're such a big deal. Um, and so, uh, so now we're, you know, kind of looking at ways in which we can be more, uh, front and center on… Claude first, st because it seems like most people, most firms are using Claude over over others.

**[13:57:59] Eric Pearson:** And it definitely makes sense, because, yeah, I mean, like that video that I showed you, it's like, the way that, you know, not talking about your sales team, or, you know, that type of thing, but a lot of people now are shifting to, instead of, like, reaching out to Google first, it's like, plot. blah blah blah ask question. Um, and, you know, that's kind of also why dashboards are changing. It's gonna be, like, kind of a one and done, and, like, poof, it's gone. Um, so, yeah, this totally makes sense. It's like, you know, we need to get… this is, like, shall we say.

**[13:58:18] Mark Lutz:** Yep.

**[13:58:34] Eric Pearson:** New World SEO.

**[13:58:35] Mark Lutz:** Exactly 100%. And like, you know what what like we want for for AI connectivity for companies is like, Hey, Claude doesn't actually know much about structure notes like.

**[13:58:36] Eric Pearson:** Yeah. Yeah. Alright.

**[13:58:50] Mark Lutz:** they're obviously super complicated. They're they have a billion terms. There are. There are 10 different words for each of those terms. So it has, you know, 4 billion or 10 billion terms. And, uh, and we have all the intelligence, all the, like, plain English kind of stuff that can help you, like, help kind of train Claude, specifically in structure notes, and then we have your data, Mr. Client, so that we can tell Claude to be able to analyze the data, because if you give Claude your data right now. Claude won't know what to do with it. So, like, it's kind of just like, hey, like, this is going to be the intel we're the.

**[13:59:25] Eric Pearson:** It's us building basically the intelligence piece so that, yeah. So like literally i could just, you know, if I've got like my bank, which you know it's going to happen eventually. If I've got my bank account data linked into Claude and everything, I just like, okay, what looks good for me to buy today?

**[13:59:27] Mark Lutz:** Yes. Exactly, exactly. So we're trying to, you know, build out that more and more, um, and as we get people more involved with our MCP, um, just trying to, you know, be more… be more tapped in here. Um…

**[13:59:41] Eric Pearson:** Yeah, sure. Do we have an MCP?

**[13:59:54] Mark Lutz:** Yes. It is… In the long string of things that need to be renamed.

**[14:00:03] Eric Pearson:** Thank you.

**[14:00:09] Mark Lutz:** railway. Sorry I've changed all. I've just like just changed all these things to 2 factor.

**[14:00:18] Eric Pearson:** I love 2FA. You know what that was also somewhat primarily done to assuade is AI looking through.

**[14:00:29] Mark Lutz:** Say it. Sorry. Say it again.

**[14:00:30] Eric Pearson:** It's one of the primary drives of 2FA is to keep AI at the gate, basically.

**[14:00:36] Mark Lutz:** Yeah, yeah. Um, but, uh, so anyways, um, in here, we have a bunch of these services, um. there's an Mtp. Through one of them but because we've used all the plain names. I don't know. I don't know which one it is.

**[14:00:56] Eric Pearson:** You know what these look like? Have you ever just spun up things on Docker and it gives a really ludicrous name to the container and you're just like, ah, yeah.

**[14:00:59] Mark Lutz:** There we go. Yes. Yes, and like, you know, I didn't even realize that, like, I could rename it when I was initially creating these things, and…

**[14:01:05] Eric Pearson:** Yes.

**[14:01:12] Mark Lutz:** But anyway, so this which I'll send you is oops. It's included. Um, is our…

**[14:01:21] Eric Pearson:** So is Railway kind of like your workflow orchestrator? Is it like an N8N kind of ish thing?

**[14:01:29] Mark Lutz:** Yes, I'm like, I know of N8N, but I'm not super familiar with it, but yes, it's where our APIs are, like, our services are held. So, um… So yeah, all of our backend stuff, really. And then and then Heroku is like our our front end where we deploy most most of our front ends. We have a few front end. Things in here as well, but for the most part, um… This. This is kind of back and stuff. So and I added you here, right? Yes, cool.

**[14:02:07] Eric Pearson:** Yeah, you granted me access, but I was like, the context when I first see this, I'm just like. Okay.

**[14:02:16] Mark Lutz:** Um… and this is, like, one of those things where I'm like…

**[14:02:19] Eric Pearson:** I didn't know if I was looking at marine layer advisors or if I got booted into somebody's only fans.

**[14:02:26] Mark Lutz:** Um, like, and this is one of the things where, like, I don't even… I'm like… Yeah. Where is. Let me know. But, um… I don't know if I can… Um, just change the name of it, and it's not gonna change anything. But anyways, um, probably should re-rename these. Um, but uh, but yeah, so MCP is in there. Uh, okay, where were we? Um, oh, I wanted to talk to you, I did watch the video of the dashboard stuff. I do think it's super interesting, I really do think that, um… That's where we are going. Vinay especially would find that really interesting, because he definitely is like super. forward thinking, I guess, and wants to like, try is trying to build for that future. Obviously, the challenge with finance and financial advisors is like, you also have to prepare for the now, and also, and then try to prepare for the future.

**[14:03:37] Eric Pearson:** Right. 100%.

**[14:03:40] Mark Lutz:** But, like, what I've seen internally, at least, like, this concept of, like, okay, like, dashboards go away, um, you know, everything is just through, kind of, like, uh, chat that's, like, adapting to who you are, is… there… I feel like there are still a lot of things that, like, a UI provides, like a more static-ish UI provides, um, like… Like alerting about, you know, calendar meetings, things like statuses of different things, reminders of stuff.

**[14:04:10] Eric Pearson:** Sure.

**[14:04:16] Mark Lutz:** Um, things that, like, aren't necessarily…

**[14:04:17] Eric Pearson:** Or like having kind of like, you know, a KPI bar, if you will, that's got like emergent action items that you need to be focused on now. Or, you know, also the other thing I thought is kind of cool is like, okay. using a UI, UX approach, and just kind of, like, pulling up, like, what we assume the 80-20 would be, you know, the 80% of what people would want to see, blah, there you go, and then you can, like, maybe give, like, options underneath, say, you can customize it this way, customize it this way, customize it this way, you know, and then… Yeah, I can refill it and whatever.

**[14:04:51] Mark Lutz:** Yep. And then I also think that, like… A lot of what… I am not seeing right now is right now. So much of AI interaction is a poll. Hey? Give me this information. Show me this. You know this like dashboard. But like. at some point, it has to be a push, where, like, you just have something pinging you, being like, hey, you have a meeting in 20 minutes, uh, it doesn't look like you've, like, prepared for it by, you know, doing whatever thing you're supposed to prepare, like, do you want me to help you prepare for it? Um…

**[14:05:20] Eric Pearson:** Oh, yeah.

**[14:05:26] Mark Lutz:** you know, you could respond or, like, click a button that's yes or no, or you can respond with, like, free text. Like, that sort of stuff, I think, is really what's going to get people, especially, um, people who are not, like, plugged in to AI and aren't thinking about it as, like, a tool.

**[14:05:39] Eric Pearson:** Got it.

**[14:05:44] Mark Lutz:** in their day to day to be more involved with it.

**[14:05:48] Eric Pearson:** I had a skill set aside for my job search and it was like I custom created it in Claude and I just said okay I would literally, so like, let's say if I knew that I was going to talk to you today, I would just say, hey, Claude, give me like a. three-paragraph brief on Marine Layer Advisors, what they do, what they're about, any information that would be pertinent to a, you know, interview with a hiring manager, interview with a technical person, you know, so it's like…

**[14:06:16] Mark Lutz:** Mm-hmm. Yep.

**[14:06:17] Eric Pearson:** So, stuff like that, yeah, and I totally could see how that… so, but we would need to kind of, like, flip it on its head, so instead of us giving the machine that, we would, like, have to basically, you know, have the machine.

**[14:06:18] Mark Lutz:** Yeah, yeah.

**[14:06:30] Eric Pearson:** assume that the person, and shall we say, is not as knowledgeable as we are to tickle it for the appropriate thing, and just actually just, hey, you know, I noticed you haven't, you know, you haven't been signed in, and you've got a meeting in an hour. Yeah, so it's like…

**[14:06:44] Mark Lutz:** Yeah, exactly.

**[14:06:45] Eric Pearson:** Yeah, ha ha ha!

**[14:06:47] Mark Lutz:** Exactly.

**[14:06:48] Eric Pearson:** No. I totally agree with you. 100%.

**[14:06:50] Mark Lutz:** And I wonder if that, like, in this kind of, like.

**[14:06:50] Eric Pearson:** Yes.

**[14:06:53] Mark Lutz:** Future non dashboard world. If that also is like an interesting like like, imagine you know, logging into. Your you know your company portal. And instead of seeing. You know all of these dashboard things. Um, you get, like, one, to your point, I think, that you mentioned before, like, your preferences of what you historically have said you care about, and then you also get a thing that's like, hey, like, this is, like. you know, this is… these are the things you care about, here are other things that you have cared about, and, like, I'm just, like, an agent that's messaging you about things, and, like, it's not as much of a, like. I have to tell you what I want. It's like, you're telling me a bunch of things, and then if I don't like it, I can, like, you know, redirect. But otherwise, I don't have to, like… I don't have to come in and, like, um, come up with the things, you know? And it's funny, because it's like…

**[14:07:42] Eric Pearson:** Right. Right, right.

**[14:07:53] Mark Lutz:** This is… this is, like… so, um… antithetical to a lot of like, a lot of concerns about how people are, how children are learning and like, it's like, hey, like we're taking away a lot of critical thinking, but it's like, okay, in this. point in case, like, I want to take away all critical thinking. I don't want people to have to think critically when they come in and, like, log into something. I don't want them to have to be like, I want to see this, I want to see that. I want them to be like, hey, here are the things that I know you want to see.

**[14:08:27] Eric Pearson:** Right.

**[14:08:28] Mark Lutz:** and tell me if they're wrong, and I'll adjust. So it's just like the reverse.

**[14:08:31] Eric Pearson:** Yeah, no, and that, I love the fact that, you know, make it adaptive and learning. The other kind of cool thing, it's not that we want to take away from, you know, it's like, yeah, you've got, what you really want though is you want urgent data up front. front. It's like, that's… that's the key. It's like, I don't need to do 5 mouse clicks that I've memorized for rote to, like, drill into a specific report that I need to look at every day. It's like, no, just surface that, you know, surface this, yeah. Totally get it.

**[14:08:58] Mark Lutz:** Yep. Yep, exactly. So yeah, it becomes more like a dynamic and just, like, learning, like, machine learning type of UI that's personalized, along with, like, the ability to free text. Chat with an agent and have it adjust the ui, or whatever needed to get you kind of what you want.

**[14:09:22] Eric Pearson:** And I mean, even like if you need to tell the, you know, the AI that's driving everything, say this is absolute shit. I don't like it.

**[14:09:29] Mark Lutz:** Yeah, yeah, 100%. But anyways, yeah, that's that's kind of what I I I thought it sparked a lot of really interesting ideas. But that's kind of how I that was the part of it that I I thought was lacking in in the person's assessment was like people still want.

**[14:09:39] Eric Pearson:** Mmhm.

**[14:09:49] Mark Lutz:** Like, people don't wanna have to, like, go in and, like, and prompt.

**[14:09:52] Eric Pearson:** Yeah. Okay.

**[14:09:53] Mark Lutz:** every single time to see stuff. They want to go in and, like, already have stuff available, because one, like, it helps for idea generation, and two, it's just, like, it's tedious to have to type in, like, show me my meetings today, and tomorrow, show me my meetings today.

**[14:10:06] Eric Pearson:** Yeah, give me my morning briefing. Yeah.

**[14:10:08] Mark Lutz:** Yeah, exactly. Um, alright, so, uh, uh, kind of shifting gears, um, you got a Luma login. I don't know if you were able to log in yet.

**[14:10:18] Eric Pearson:** Two.

**[14:10:18] Mark Lutz:** To Luma.

**[14:10:20] Eric Pearson:** Oh, yeah, I'm able. Oh, I'm in. Yep.

**[14:10:22] Mark Lutz:** Okay, cool. So, uh, just wanna walk through this really quick. Um… Uh, I think we talked a little bit about it before, but, um, in terms of, like, what we utilize. Um, we primarily utilize two tabs. Um, one is lifecycle. Um… to regular events. It will hopefully be quicker. So freaking slow. But, but, yeah. So in here, we have, like, views of, of of. Structure notes that are in. Um, our book. Or, for an advisor, it would be, like, in each of the advisors' book, and we see all the advisors under our umbrella. Um… And the primary kind of ways that people care about is events which would be like either coupons that get them cash into their accounts or redemption events being called or maturing. And so this kind of tracks, like, you know, of different events in on different days. This.
