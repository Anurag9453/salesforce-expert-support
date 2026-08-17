@isTest
private class IssueNotificationHandlerTest {
    @isTest
    static void sendsOneEmailPerIssue() {
        Lead lead = new Lead(
            FirstName = 'Kavita', LastName = 'Nair', Company = 'Not provided (web enquiry)',
            Email = 'kavita@example.com', Phone = '+919988776655', Status = 'Open - Not Contacted',
            Duration_Minutes__c = 60, Quoted_Amount__c = 36.35, Quoted_Currency__c = 'USD'
        );
        insert lead;

        Test.startTest();
        insert new Issue_Information__c(
            Lead__c = lead.Id,
            Description__c = 'Apex trigger fires twice and duplicates child records.',
            Submitted_At__c = System.now()
        );
        Integer sent = Limits.getEmailInvocations();
        Test.stopTest();

        System.assertEquals(1, sent, 'one notification should have been sent');
    }

    @isTest
    static void ignoresAnIssueWithNoLead() {
        Test.startTest();
        insert new Issue_Information__c(Description__c = 'Orphan', Submitted_At__c = System.now());
        System.assertEquals(0, Limits.getEmailInvocations(), 'nothing to notify about');
        Test.stopTest();
    }

    @isTest
    static void schedulesAReminderForACallback() {
        Lead lead = newLead();
        Datetime callAt = System.now().addDays(3);

        Test.startTest();
        insert new Issue_Information__c(
            Lead__c = lead.Id,
            Description__c = 'Flow fails on a large data volume.',
            Request_Type__c = 'Scheduled',
            Preferred_Call_At__c = callAt,
            Preferred_Timezone__c = 'Asia/Kolkata',
            Submitted_At__c = System.now()
        );
        Test.stopTest();

        List<Task> tasks = [SELECT Subject, WhoId, IsReminderSet, ReminderDateTime, ActivityDate,
                                  OwnerId, Description
                             FROM Task WHERE WhoId = :lead.Id];
        System.assertEquals(1, tasks.size(), 'the callback should have produced one task');
        System.assert(tasks[0].Subject.contains('Scheduled request'),
            'the subject should say what kind of request it is: ' + tasks[0].Subject);
        System.assertEquals(true, tasks[0].IsReminderSet, 'a future call should alert the owner');
        System.assertEquals(callAt.addMinutes(-15), tasks[0].ReminderDateTime,
            'the reminder belongs a quarter of an hour before the call, not at it');
        System.assertEquals(lead.OwnerId, tasks[0].OwnerId, 'whoever owns the lead makes the call');
        System.assert(tasks[0].Description.contains('Asia/Kolkata'),
            'the customer chose a zone and the owner needs to see it');

        /*
          The number, not just the zone name. This is the bug the assertion exists
          for: a bare Datetime.format() renders in whichever user context the
          trigger ran in — the integration user — so an afternoon call in Kolkata
          was written down as the middle of the night.
        */
        String expected = callAt.format('h:mm a', 'Asia/Kolkata');
        System.assert(tasks[0].Description.contains(expected),
            'the customer\'s own clock reading (' + expected + ') should appear: ' +
            tasks[0].Description);
        System.assert(
            tasks[0].Description.contains(callAt.format('h:mm a', UserInfo.getTimeZone().getID()))
            || expected == callAt.format('h:mm a', UserInfo.getTimeZone().getID()),
            'the owner needs their own clock too: ' + tasks[0].Description);
    }

    @isTest
    static void doesNotScheduleAReminderForAnInstantRequest() {
        Lead lead = newLead();

        Test.startTest();
        insert new Issue_Information__c(
            Lead__c = lead.Id,
            Description__c = 'Production deploy is blocked right now.',
            Request_Type__c = 'Instant',
            Submitted_At__c = System.now()
        );
        Test.stopTest();

        // An instant request has no future moment to be reminded about. A task
        // here would be noise the team learns to dismiss.
        System.assertEquals(0, [SELECT COUNT() FROM Task WHERE WhoId = :lead.Id],
            'an instant request should not create a reminder');
    }

    @isTest
    static void stillCreatesTheTaskWhenTheCallIsAlreadyImminent() {
        Lead lead = newLead();

        Test.startTest();
        insert new Issue_Information__c(
            Lead__c = lead.Id,
            Description__c = 'Asked for a call five minutes from now.',
            Request_Type__c = 'Scheduled',
            // Inside the 15-minute reminder window, so the reminder time would be
            // in the past — which Salesforce rejects.
            Preferred_Call_At__c = System.now().addMinutes(5),
            Submitted_At__c = System.now()
        );
        Test.stopTest();

        List<Task> tasks = [SELECT IsReminderSet FROM Task WHERE WhoId = :lead.Id];
        System.assertEquals(1, tasks.size(), 'losing the popup must not cost us the task');
        System.assertEquals(false, tasks[0].IsReminderSet, 'no alert can fire in the past');
    }

    private static Lead newLead() {
        Lead lead = new Lead(
            FirstName = 'Kavita', LastName = 'Nair', Company = 'Not provided (web enquiry)',
            Email = 'kavita@example.com', Phone = '+919988776655', Status = 'Open - Not Contacted',
            Duration_Minutes__c = 60, Quoted_Amount__c = 36.35, Quoted_Currency__c = 'USD'
        );
        insert lead;
        return [SELECT Id, OwnerId FROM Lead WHERE Id = :lead.Id];
    }
}