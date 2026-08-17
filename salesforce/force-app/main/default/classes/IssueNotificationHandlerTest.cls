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
}