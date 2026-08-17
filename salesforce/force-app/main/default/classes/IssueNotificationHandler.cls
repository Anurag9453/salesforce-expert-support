public with sharing class IssueNotificationHandler {
    /**
     * Emails whoever owns the lead when a customer raises a request.
     *
     * Fires on Issue_Information__c rather than Lead, and the reason matters:
     * the platform writes the Lead first and the issue a moment later, so a
     * Lead trigger would send a notification whose whole point — what the
     * customer actually asked for — had not been written yet.
     *
     * Sends to the Lead's owner, which the org's assignment rules have already
     * chosen. That keeps routing in one place instead of hard-coding an address
     * here that has to be maintained separately.
     */
    private static final String TEMPLATE_NAME = 'New Request Notification';

    /** How long before the call the owner gets nudged. */
    private static final Integer REMINDER_LEAD_MINUTES = 15;

    public static void notifyOwners(List<Issue_Information__c> issues) {
        Set<Id> issueIds = new Set<Id>();
        for (Issue_Information__c issue : issues) {
            if (issue.Lead__c != null) {
                issueIds.add(issue.Id);
            }
        }
        if (issueIds.isEmpty()) {
            return;
        }

        // One query, not one per record: a bulk load of enquiries must not
        // multiply into a query per row.
        Map<Id, Issue_Information__c> loaded = new Map<Id, Issue_Information__c>(
            [SELECT Id, Name, Lead__c, Lead__r.OwnerId, Lead__r.Owner.Email,
                    Request_Type__c, Preferred_Call_At__c, Preferred_Timezone__c
               FROM Issue_Information__c
              WHERE Id IN :issueIds]
        );

        sendNotifications(loaded.values());
        scheduleCallReminders(loaded.values());
    }

    private static void sendNotifications(List<Issue_Information__c> issues) {
        List<EmailTemplate> templates = [
            SELECT Id FROM EmailTemplate WHERE Name = :TEMPLATE_NAME LIMIT 1
        ];
        if (templates.isEmpty()) {
            return;
        }

        List<Messaging.SingleEmailMessage> messages = new List<Messaging.SingleEmailMessage>();
        for (Issue_Information__c issue : issues) {
            if (issue.Lead__r == null || issue.Lead__r.OwnerId == null) {
                continue;
            }
            // Queue owners are not users and cannot be a targetObjectId.
            if (String.valueOf(issue.Lead__r.OwnerId).startsWith('00G')) {
                continue;
            }

            Messaging.SingleEmailMessage message = new Messaging.SingleEmailMessage();
            message.setTemplateId(templates[0].Id);
            message.setTargetObjectId(issue.Lead__r.OwnerId);
            message.setWhatId(issue.Id);
            // The notification is a side effect, not a record of anything: saving
            // it as an activity would clutter every lead with noise.
            message.setSaveAsActivity(false);
            messages.add(message);
        }

        if (messages.isEmpty()) {
            return;
        }

        // allOrNone = false: a single bad address must not roll back the issue
        // records that were just written.
        List<Messaging.SendEmailResult> results = Messaging.sendEmail(messages, false);
        for (Messaging.SendEmailResult result : results) {
            if (!result.isSuccess()) {
                System.debug(LoggingLevel.ERROR,
                    'Issue notification failed: ' + result.getErrors()[0].getMessage());
            }
        }
    }

    /**
     * A reminder task for the callback a customer asked for.
     *
     * Only for enquiries that carry a time. An instant request has no future
     * moment to be reminded about — the whole point is that somebody picks it up
     * now — so a task there would be noise the team learns to dismiss.
     *
     * The reminder is set a quarter of an hour early, because a reminder that
     * fires at the moment of the call is a reminder that arrives late.
     */
    private static void scheduleCallReminders(List<Issue_Information__c> issues) {
        List<Task> reminders = new List<Task>();
        Map<Id, String> ownerZones = ownerZonesFor(issues);

        for (Issue_Information__c issue : issues) {
            if (issue.Preferred_Call_At__c == null) {
                continue;
            }
            if (issue.Lead__r == null || issue.Lead__r.OwnerId == null) {
                continue;
            }

            Datetime callAt = issue.Preferred_Call_At__c;
            Datetime remindAt = callAt.addMinutes(-REMINDER_LEAD_MINUTES);

            Task reminder = new Task(
                OwnerId = issue.Lead__r.OwnerId,
                // WhoId, not WhatId: the lead is a person to call, and putting it
                // here is what makes the task show on their record with the phone
                // number attached.
                WhoId = issue.Lead__c,
                Subject = 'Call back — ' + describeCall(issue),
                ActivityDate = callAt.date(),
                Priority = 'High',
                Status = 'Not Started',
                Description = describeCallTime(
                    callAt,
                    issue.Preferred_Timezone__c,
                    zoneOf(ownerZones, issue.Lead__r.OwnerId))
            );

            // Salesforce rejects a reminder in the past, and a callback time can
            // legitimately be nearly now — so the task is still created, just
            // without the alert. Losing the popup is much better than losing the
            // task, which a thrown exception would also cost us the enquiry.
            if (remindAt > Datetime.now()) {
                reminder.IsReminderSet = true;
                reminder.ReminderDateTime = remindAt;
            }

            reminders.add(reminder);
        }

        if (reminders.isEmpty()) {
            return;
        }

        // Same reasoning as the email: a task that will not insert must not roll
        // back the enquiry it was meant to be about.
        List<Database.SaveResult> results = Database.insert(reminders, false);
        for (Database.SaveResult result : results) {
            if (!result.isSuccess()) {
                System.debug(LoggingLevel.ERROR,
                    'Call reminder failed: ' + result.getErrors()[0].getMessage());
            }
        }
    }

    /**
     * The requested time in the customer's own zone, and again in the owner's.
     *
     * Both, because either alone misleads. The owner needs their own clock —
     * that is the one they will be looking at when the reminder fires — and the
     * customer's zone has to be spelled out or nobody can tell which of the two
     * numbers the customer actually asked for.
     *
     * Every rendering names its zone explicitly. A bare `format()` uses whichever
     * user's context the trigger ran in, which is the integration user and is
     * nobody's clock: it showed half past three in the afternoon in Kolkata as
     * three in the morning.
     */
    private static String describeCallTime(Datetime callAt, String customerZone, String ownerZone) {
        String format = 'EEE d MMM yyyy \'at\' h:mm a';
        String theirs = renderIn(callAt, customerZone, format);
        String ours = renderIn(callAt, ownerZone, format);

        if (theirs == null) {
            return 'Requested call time: ' + ours + ' (' + ownerZone + ')';
        }
        if (theirs == ours) {
            return 'Requested call time: ' + theirs + ' (' + customerZone + ')';
        }
        return 'Requested call time: ' + theirs + ' (' + customerZone + ')' +
            '\nIn your time zone: ' + ours + ' (' + ownerZone + ')';
    }

    /** Null when the zone is missing or the platform does not recognise it. */
    private static String renderIn(Datetime moment, String timeZone, String format) {
        if (String.isBlank(timeZone)) {
            return null;
        }
        try {
            return moment.format(format, timeZone);
        } catch (Exception e) {
            // A bad zone id must not cost us the task. The application validates
            // the customer's zone before it reaches us, so this is a backstop.
            System.debug(LoggingLevel.WARN, 'Unrecognised time zone: ' + timeZone);
            return null;
        }
    }

    /**
     * Each lead owner's time zone, in one query.
     *
     * Separate rather than `Lead__r.Owner.TimeZoneSidKey`, which does not
     * compile: `Owner` is a polymorphic Name relationship covering both users
     * and queues, and only the User side has a zone.
     */
    private static Map<Id, String> ownerZonesFor(List<Issue_Information__c> issues) {
        Set<Id> ownerIds = new Set<Id>();
        for (Issue_Information__c issue : issues) {
            if (issue.Preferred_Call_At__c != null && issue.Lead__r != null) {
                ownerIds.add(issue.Lead__r.OwnerId);
            }
        }

        Map<Id, String> zones = new Map<Id, String>();
        if (ownerIds.isEmpty()) {
            return zones;
        }
        for (User owner : [SELECT Id, TimeZoneSidKey FROM User WHERE Id IN :ownerIds]) {
            zones.put(owner.Id, owner.TimeZoneSidKey);
        }
        return zones;
    }

    /** Falls back to the running context when the owner is a queue, not a user. */
    private static String zoneOf(Map<Id, String> zones, Id ownerId) {
        String zone = zones.get(ownerId);
        return String.isBlank(zone) ? UserInfo.getTimeZone().getID() : zone;
    }

    private static String describeCall(Issue_Information__c issue) {
        String label = String.isBlank(issue.Request_Type__c)
            ? 'support request'
            : issue.Request_Type__c + ' request';
        return label + ' (' + issue.Name + ')';
    }
}