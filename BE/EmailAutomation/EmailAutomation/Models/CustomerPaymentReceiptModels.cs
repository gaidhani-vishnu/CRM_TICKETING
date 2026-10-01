using System;
using Newtonsoft.Json;

namespace EmailAutomation.Models
{
    // DTOs for the Customer Payment Receipt tab (CustomerPaymentReceiptController).
    //
    // Every property carries [JsonProperty] because WebApiConfig leaves the JSON
    // resolver PascalCase; the Angular models are camelCase.

    /// <summary>A customer of one unit, with the booking (ACCOUNT_ITEM_NO) the name stands for.</summary>
    public class ReceiptCustomerOption
    {
        [JsonProperty("accountItemNo")]
        public string AccountItemNo { get; set; }

        [JsonProperty("customerName")]
        public string CustomerName { get; set; }
    }

    public class PortalHandoffTokenRequest
    {
        [JsonProperty("accountItemNo")]
        public string AccountItemNo { get; set; }
    }

    public class PortalHandoffTokenResponse
    {
        [JsonProperty("handoffId")]
        public Guid HandoffId { get; set; }

        [JsonProperty("token")]
        public string Token { get; set; }

        /// <summary>The portal page to open, with the token already in its #fragment.</summary>
        [JsonProperty("portalUrl")]
        public string PortalUrl { get; set; }

        [JsonProperty("expiresAt")]
        public DateTime ExpiresAt { get; set; }
    }

    public class PortalHandoffStatusResponse
    {
        [JsonProperty("handoffId")]
        public Guid HandoffId { get; set; }

        /// <summary>"PENDING", "RECORD_SAVED" or "SESSION_EXPIRED".</summary>
        [JsonProperty("status")]
        public string Status { get; set; }

        [JsonProperty("accountItemNo")]
        public string AccountItemNo { get; set; }

        [JsonProperty("ticketNumber")]
        public string TicketNumber { get; set; }
    }
}
