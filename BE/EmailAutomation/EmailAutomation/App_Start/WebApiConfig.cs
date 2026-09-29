using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Web.Routing;
using System.Threading.Tasks;
using System.Threading;
using System.Web.Http;
using Newtonsoft.Json.Serialization;
using System.Configuration;
using System.Web.Http.Cors;



namespace EmailAutomation
{
    //public static class WebApiConfig
    //{
    //    //public static void Register(HttpConfiguration config)
    //    //{
    //    //    config.MapHttpAttributeRoutes();

    //    //    config.Routes.MapHttpRoute(
    //    //        name: "DefaultApi",
    //    //        routeTemplate: "api/{controller}/{id}",
    //    //        defaults: new { id = RouteParameter.Optional }
    //    //    );
    //    //}

    //    public static void Register(HttpConfiguration config)
    //    {
    //        // Get the allowed origins from Web.config
    //        string allowedOrigins = ConfigurationManager.AppSettings["AllowedOrigins"];
    //        var cors = new EnableCorsAttribute(allowedOrigins, "Content-Type, Authorization", "GET, POST, PUT, DELETE");

    //        config.EnableCors(cors);

    //        // Remove XML formatter to use only JSON
    //        config.Formatters.Remove(config.Formatters.XmlFormatter);

    //        // Configure JSON formatter settings
    //        var jsonFormatter = config.Formatters.JsonFormatter;
    //        jsonFormatter.SerializerSettings.ContractResolver = new CamelCasePropertyNamesContractResolver();
    //        jsonFormatter.SerializerSettings.Formatting = Newtonsoft.Json.Formatting.Indented;



    //        config.MapHttpAttributeRoutes();

    //        // Define your default route
    //        config.Routes.MapHttpRoute(
    //            name: "DefaultApi",
    //            routeTemplate: "api/{controller}/{action}/{id}",
    //            defaults: new { id = RouteParameter.Optional }
    //        );

    //        // Add support for preflight requests
    //        config.MessageHandlers.Add(new PreflightRequestHandler());
    //    }
    //    public class PreflightRequestHandler : DelegatingHandler
    //    {
    //        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    //        {
    //            if (request.Method == HttpMethod.Options)
    //            {
    //                var response = new HttpResponseMessage(System.Net.HttpStatusCode.OK);
    //                response.Headers.Add("Access-Control-Allow-Origin", "*");
    //                response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
    //                response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization");
    //                return response;
    //            }

    //            return await base.SendAsync(request, cancellationToken);
    //        }
    //    }
    //}

    public static class WebApiConfig
    {
        //public static void Register(HttpConfiguration config)
        //{
        //    config.MapHttpAttributeRoutes();

        //    config.Routes.MapHttpRoute(
        //        name: "DefaultApi",
        //        routeTemplate: "api/{controller}/{id}",
        //        defaults: new { id = RouteParameter.Optional }
        //    );
        //}

        public static void Register(HttpConfiguration config)
        {
            // Get the allowed origins from Web.config
            string allowedOrigins = ConfigurationManager.AppSettings["AllowedOrigins"];
            var cors = new EnableCorsAttribute(allowedOrigins, "Content-Type, Authorization", "GET, POST, PUT, DELETE");

            config.EnableCors(cors);

            // Remove XML formatter to use only JSON
            config.Formatters.Remove(config.Formatters.XmlFormatter);

            // Configure JSON formatter settings
            var jsonFormatter = config.Formatters.JsonFormatter;
            jsonFormatter.SerializerSettings.ContractResolver = new CamelCasePropertyNamesContractResolver();
            jsonFormatter.SerializerSettings.Formatting = Newtonsoft.Json.Formatting.Indented;
            var json = config.Formatters.JsonFormatter;
            json.SerializerSettings.ContractResolver = new Newtonsoft.Json.Serialization.DefaultContractResolver();


            config.MapHttpAttributeRoutes();

            // Define your default route
            /*config.Routes.MapHttpRoute(
                name: "DefaultApi",
                routeTemplate: "api/{controller}/{action}/{id}",
                defaults: new { id = RouteParameter.Optional }
            );*/

            config.Routes.MapHttpRoute(
               name: "DefaultApi",
               routeTemplate: "api/{controller}/{action}/{id}",
               defaults: new { id = RouteParameter.Optional }
           );

            // Add support for preflight requests
            config.MessageHandlers.Add(new PreflightRequestHandler());
        }
        public class PreflightRequestHandler : DelegatingHandler
        {
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                if (request.Method == HttpMethod.Options)
                {
                    var response = new HttpResponseMessage(System.Net.HttpStatusCode.OK);
                    response.Headers.Add("Access-Control-Allow-Origin", "*");
                    response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
                    response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization");
                    return response;
                }

                return await base.SendAsync(request, cancellationToken);
            }
        }
    }
}
